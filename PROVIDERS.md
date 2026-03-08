# Task Provider Integration Guide

This document describes how UpQ task server integrates with each supported task provider, and how Apple Reminders could be added via CalDAV if needed in the future.

---

## Table of Contents

1. [Microsoft To Do (Microsoft Graph API)](#1-microsoft-to-do-microsoft-graph-api)
2. [Google Tasks API](#2-google-tasks-api)
3. [Apple Reminders (CalDAV — Not Currently Integrated)](#3-apple-reminders-caldav--not-currently-integrated)
4. [Unified Provider Interface](#4-unified-provider-interface)
5. [Adding a New Provider](#5-adding-a-new-provider)

---

## 1. Microsoft To Do (Microsoft Graph API)

### Overview

Microsoft To Do tasks are accessed via the **Microsoft Graph API** (`https://graph.microsoft.com/v1.0`). Authentication uses OAuth 2.0 with the Microsoft identity platform (formerly Azure AD).

### App Registration (Azure Portal)

1. Go to [portal.azure.com](https://portal.azure.com) → **Azure Active Directory** → **App registrations** → **New registration**
2. Set a redirect URI matching `MICROSOFT_REDIRECT_URI` in `.env`
3. Under **API permissions**, add:
   - `Tasks.ReadWrite` (Delegated)
   - `User.Read` (Delegated)
   - `offline_access` (Delegated) — required for refresh tokens
4. Under **Certificates & secrets**, create a client secret
5. Copy the **Application (client) ID**, **Directory (tenant) ID**, and **client secret** to `.env`

### Environment Variables

| Variable | Description |
|---|---|
| `MICROSOFT_CLIENT_ID` | Azure app registration client ID |
| `MICROSOFT_CLIENT_SECRET` | Azure app registration client secret |
| `MICROSOFT_TENANT_ID` | `consumers` for personal accounts; `common` for any account; specific GUID for a single tenant |
| `MICROSOFT_REDIRECT_URI` | Must exactly match the redirect URI registered in Azure |

### OAuth 2.0 Flow

```
1. Client calls GET /auth/microsoft/url
   → Server builds authorization URL:
     https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize
       ?client_id=…
       &response_type=code
       &redirect_uri=…
       &scope=Tasks.ReadWrite offline_access User.Read
       &response_mode=query
       &prompt=select_account

2. User authenticates and consents in browser

3. Microsoft redirects to MICROSOFT_REDIRECT_URI?code=…

4. Server calls GET /auth/microsoft/callback
   → POSTs code to: https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
   → Receives: { access_token, refresh_token, expires_in, … }
   → Stores encrypted tokens in user_credentials table

5. Provider initialized with stored access_token + refresh_token
   → Uses @microsoft/microsoft-graph-client to make API calls
```

### API Endpoints Used

| Operation | Graph API Call |
|---|---|
| List task lists | `GET /me/todo/lists` |
| Get tasks in list | `GET /me/todo/lists/{listId}/tasks` |
| Get single task | `GET /me/todo/lists/{listId}/tasks/{taskId}` |
| Create task | `POST /me/todo/lists/{listId}/tasks` |
| Update task | `PATCH /me/todo/lists/{listId}/tasks/{taskId}` |
| Complete task | `PATCH /me/todo/lists/{listId}/tasks/{taskId}` with `{ status: "completed" }` |
| Delete task | `DELETE /me/todo/lists/{listId}/tasks/{taskId}` |

### Task Object Mapping

| hb Task Field | Microsoft Graph Field | Notes |
|---|---|---|
| `id` | `id` | Opaque string |
| `name` | `title` | — |
| `completed` | `status === "completed"` | Boolean |
| `notes` | `body.content` | HTML stripped to plain text |
| `dueDate` | `dueDateTime.dateTime` | UTC datetime string |
| `priority` | `importance` | `"low"` / `"normal"` / `"high"` |
| `createdDate` | `createdDateTime` | — |
| `updated` | `lastModifiedDateTime` | — |

### Dependencies

```
@microsoft/microsoft-graph-client   — Graph API client
@azure/identity                     — Azure credential types (used for service-to-service flow)
```

### Notes

- `prompt=select_account` is set on the auth URL so users can always choose which Microsoft account to connect, even if they have an existing session.
- The provider also supports a **client credentials flow** (service-to-service) as a fallback when no user access token is available — used for admin/testing scenarios where `clientId`, `clientSecret`, and `tenantId` are all configured.

---

## 2. Google Tasks API

### Overview

Google Tasks are accessed via the **Google Tasks REST API v1** (`https://tasks.googleapis.com/tasks/v1`). Authentication uses OAuth 2.0 with the Google identity platform.

### Google Cloud Console Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services** → **Enable APIs** → enable **Tasks API**
2. Go to **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
3. Set application type to **Web application**
4. Add an **Authorized redirect URI** matching `GOOGLE_REDIRECT_URI` in `.env`
5. Copy the **client ID** and **client secret** to `.env`
6. Configure the **OAuth consent screen** (required before users can authorize)

### Environment Variables

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Must exactly match the URI in Google Cloud Console |

### OAuth 2.0 Flow

```
1. Client calls GET /auth/google/url
   → Server builds authorization URL via googleapis OAuth2 client:
     https://accounts.google.com/o/oauth2/v2/auth
       ?client_id=…
       &redirect_uri=…
       &response_type=code
       &scope=https://www.googleapis.com/auth/tasks
       &access_type=offline      ← ensures a refresh_token is issued

2. User authenticates and grants Tasks permission in browser

3. Google redirects to GOOGLE_REDIRECT_URI?code=…

4. Server calls GET /auth/google/callback
   → Calls oauth2Client.getToken(code)
   → Receives: { access_token, refresh_token, expiry_date, … }
   → Stores encrypted tokens in user_credentials table

5. Provider initialized with stored access_token + refresh_token
   → Uses googleapis tasks client to make API calls
   → oauth2Client automatically refreshes the access_token when expired
```

### API Endpoints Used

| Operation | Tasks API Call |
|---|---|
| List task lists | `tasklists.list()` |
| Get tasks in list | `tasks.list({ tasklist, showCompleted: true, showHidden: true })` |
| Get single task | `tasks.get({ tasklist, task })` |
| Create task | `tasks.insert({ tasklist, requestBody })` |
| Update task | `tasks.patch({ tasklist, task, requestBody })` |
| Complete task | `tasks.update({ tasklist, task, requestBody: { status: "completed" } })` |
| Delete task | `tasks.delete({ tasklist, task })` |

### Task Object Mapping

| hb Task Field | Google Tasks Field | Notes |
|---|---|---|
| `id` | `id` | Opaque string |
| `name` | `title` | — |
| `completed` | `status === "completed"` | Boolean |
| `notes` | `notes` | Plain text only |
| `dueDate` | `due` | RFC 3339 datetime |
| `priority` | — | Always `"low"` (Google Tasks has no priority field) |
| `updated` | `updated` | RFC 3339 datetime |
| `position` | `position` | String; preserves user sort order |

### Dependencies

```
googleapis   — Official Google API client library (includes OAuth2 and Tasks)
```

### Notes

- `access_type: offline` in the auth URL is required to receive a `refresh_token`. Without it, the token expires and the user must re-authorize.
- `showCompleted: true` and `showHidden: true` are set on `tasks.list()` so no tasks are silently omitted. Clients can filter by `completed` status as needed.
- The `position` field is returned so clients can preserve the user's manual drag-and-drop sort order.
- Google Tasks does not support task priority, importance, categories, or subtask nesting beyond one level.

---

## 3. Apple Reminders (CalDAV — Not Currently Integrated)

Apple does not provide an official REST API for Reminders. The closest option is **CalDAV**, a standard internet protocol that iCloud exposes for calendar and reminder data.

> **Note:** Apple Reminders is not integrated into this server because it lacks OAuth support, requires storing users' Apple credentials (a security liability), and is unreliable for multi-user SaaS deployments. This section documents the methodology for reference.

### Protocol

- **CalDAV** (RFC 4791) — HTTP-based protocol built on WebDAV, using iCal format (`.ics`) for data
- Reminders are stored as **VTODO** objects within CalDAV collections
- iCloud CalDAV server: `https://caldav.icloud.com`

### Authentication

iCloud CalDAV requires:
- **Apple ID** (email address)
- **App-specific password** — generated at [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords

Regular Apple ID passwords **cannot** be used with CalDAV. Two-factor authentication (2FA) on the Apple account makes app-specific passwords mandatory.

There is **no OAuth flow** — credentials must be stored and sent with every request using HTTP Basic authentication.

### Node.js Implementation

The `tsdav` library provides a CalDAV client for Node.js:

```bash
npm install tsdav
```

```javascript
const { DAVClient } = require('tsdav');

const client = new DAVClient({
  serverUrl: 'https://caldav.icloud.com',
  credentials: {
    username: 'user@icloud.com',
    password: 'app-specific-password',
  },
  authMethod: 'Basic',
  defaultAccountType: 'caldav',
});

await client.login();

// Fetch all reminder lists (CalDAV calendars of type VTODO)
const calendars = await client.fetchCalendars();
const reminderLists = calendars.filter(c =>
  c.components?.includes('VTODO')
);

// Fetch reminders from a list
const objects = await client.fetchCalendarObjects({
  calendar: reminderLists[0],
});

// Parse VTODO iCal data
// Each object.data is a raw .ics string containing a VTODO component
```

### VTODO Data Format

Each reminder is an iCal VTODO component:

```
BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:abc123@icloud.com
SUMMARY:Buy groceries
DESCRIPTION:Milk, eggs, bread
DUE;VALUE=DATE:20260315
STATUS:NEEDS-ACTION
CREATED:20260301T120000Z
LAST-MODIFIED:20260301T120000Z
END:VTODO
END:VCALENDAR
```

Parse with `ical.js`:

```bash
npm install ical.js
```

```javascript
const ICAL = require('ical.js');

function parseTodo(icsString) {
  const parsed = ICAL.parse(icsString);
  const comp   = new ICAL.Component(parsed);
  const vtodo  = comp.getFirstSubcomponent('vtodo');

  return {
    id:        vtodo.getFirstPropertyValue('uid'),
    name:      vtodo.getFirstPropertyValue('summary'),
    notes:     vtodo.getFirstPropertyValue('description'),
    dueDate:   vtodo.getFirstPropertyValue('due')?.toString(),
    completed: vtodo.getFirstPropertyValue('status') === 'COMPLETED',
    updated:   vtodo.getFirstPropertyValue('last-modified')?.toString(),
  };
}
```

### Creating and Updating Reminders

CalDAV uses HTTP `PUT` to create or update a VTODO object at a specific URL:

```javascript
await client.createCalendarObject({
  calendar: reminderList,
  filename:  `${uid}.ics`,
  iCalString: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${name}\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR`,
});
```

Completion is a `PUT` with `STATUS:COMPLETED` and `COMPLETED:<datetime>` set.

Deletion is an HTTP `DELETE` to the object's URL.

### Limitations

| Limitation | Detail |
|---|---|
| No OAuth | App-specific passwords only; users cannot use their normal Apple ID password |
| Credential storage | Server must store each user's Apple credentials — a significant security liability |
| No webhooks | Must poll CalDAV for changes; iCloud does not push notifications |
| Rate limiting | Apple rate-limits CalDAV requests; aggressive polling may trigger blocks |
| iCloud only | Reminders stored locally on-device (not synced to iCloud) are inaccessible |
| API instability | iCloud CalDAV endpoints change without notice |
| No priority field | VTODO `PRIORITY` property is not reliably set by Apple's clients |
| Terms of Service | Third-party automation of iCloud is tolerated but not officially supported |

### Why This Approach Is Not Used

For a multi-user SaaS:
- **Credential storage**: Each user's Apple ID + app-specific password would need to be stored encrypted on the server. If the server is compromised, all users' Apple accounts are at risk.
- **No token revocation**: Unlike OAuth, there is no way for users to revoke access to just this app without changing their Apple ID password or deleting the app-specific password.
- **No server-push**: CalDAV requires polling, adding latency and API call overhead.
- **Reliability**: iCloud CalDAV is known to return inconsistent results and occasionally requires re-authentication.

In contrast, Microsoft and Google both provide OAuth 2.0 flows with scoped, revocable tokens and webhook/push notification support.

---

## 4. Unified Provider Interface

All active providers implement the same method surface, allowing server routes to remain provider-agnostic:

```javascript
provider.initialize(accessToken, refreshToken)
provider.getLists()
provider.getListCounts(onlyIncomplete)
provider.getTasks(listId)
provider.getTask(listId, taskId)
provider.createTask(listId, taskData)
provider.updateTask(listId, taskId, taskData)
provider.completeTask(listId, taskId)
provider.deleteTask(listId, taskId)
```

### Normalized Task Object

All providers return tasks with this shared shape:

```javascript
{
  id:          string,    // provider-assigned opaque ID
  name:        string,    // task title
  completed:   boolean,
  notes:       string | undefined,
  dueDate:     string | undefined,  // ISO 8601 or RFC 3339
  priority:    "low" | "normal" | "high",
  updated:     string | undefined,
  position:    string | undefined   // Google only; preserves sort order
}
```

Provider-specific fields (e.g., `importance`, `categories` for Microsoft; `parent`, `links` for Google) are included in addition to the common fields where available.

---

## 5. Adding a New Provider

To add a new task provider:

1. Create `src/providers/{name}.js` implementing all methods in the unified interface above
2. Add an Azure/Google-equivalent app registration and OAuth flow if applicable
3. Register the provider in `src/task-server.js`:
   - Import the class
   - Add a factory in `providerFactories`
   - Add config env vars
   - Add OAuth routes (`/auth/{name}/url`, `/auth/{name}/callback`)
4. Add the provider name to:
   - `validProviders` in the `PATCH /auth/default-provider` route
   - The initial status object in `GET /auth/providers/status`
   - The provider map in the relevant web UI pages (`lists.html`, `tasks.html`, `all-tasks.html`, `settings.html`)
5. Add environment variables to `.env.example` and document them in `FEATURES.md`
