# Task Provider Integration Guide

This document describes how UpQ task server integrates with each supported task provider, and how Apple Reminders could be added via CalDAV if needed in the future.

---

## Table of Contents

1. [Microsoft To Do (Microsoft Graph API)](#1-microsoft-to-do-microsoft-graph-api)
2. [Google Tasks API](#2-google-tasks-api)
3. [Apple Reminders (WebSocket Bridge)](#3-apple-reminders-websocket-bridge)
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

## 3. Apple Reminders (WebSocket Bridge)

### Overview

Apple does not provide a cloud API for Reminders suitable for multi-user SaaS. The bridge approach solves this without storing Apple credentials on the server: a lightweight local server ([hb-task-server](https://github.com/handsbreadth/hb-task-server)) runs on the user's Mac, reads Reminders via AppleScript, and maintains a persistent outbound WebSocket connection to this server. Because the local server initiates the connection, it works behind NAT and home firewalls with no port forwarding required.

### Architecture

```
UpQ (cloud)                             hb-task-server (user's Mac)
─────────────────────────────────────   ────────────────────────────────
bridge-server.js  ←── WebSocket ───── src/bridge.js
  connections map                          ↓
  request(userId, method, params)       providers['apple']
       ↓                                  ↓
apple-bridge.js                        AppleRemindersProvider
  (implements provider interface)         (AppleScript)
```

### Authentication

Each user has one bridge API key stored in the `bridge_api_keys` table as a SHA-256 hash (the raw key is never stored). The local server sends the key in the first WebSocket message; the cloud server looks up the hash and associates the connection with the matching user account.

| Step | Who | Action |
|------|-----|--------|
| 1 | User (via UpQ API) | `POST /auth/bridge/key` → receives a one-time 64-char hex key |
| 2 | User (on their Mac) | Adds `BRIDGE_URL` and `BRIDGE_API_KEY` to local `.env` |
| 3 | hb-task-server | Connects to `wss://<upq>/bridge`, sends `{ type: "auth", apiKey }` |
| 4 | bridge-server.js | Hashes the key, looks up `user_id`, registers the socket |
| 5 | hb-task-server | Receives `{ type: "auth_ok" }`, ready to accept requests |

### Message Protocol

All messages are JSON. The cloud server acts as the requester; the local server executes and responds.

**Request** (cloud → local):
```json
{ "type": "request", "id": "<uuid>", "method": "getLists", "params": {} }
```

**Response** (local → cloud):
```json
{ "type": "response", "id": "<uuid>", "result": [ ... ] }
{ "type": "response", "id": "<uuid>", "error": "error message" }
```

**Keepalive** (cloud → local, every 30 seconds):
```json
{ "type": "ping" }
{ "type": "pong" }
```

### Supported Methods

| Method | Params | Description |
|--------|--------|-------------|
| `getLists` | — | Return all Reminders lists |
| `getTasks` | `{ listId, options }` | Return tasks in a list |
| `getTask` | `{ listId, taskId }` | Return a single task |
| `createTask` | `{ listId, taskData }` | Create a new task |
| `updateTask` | `{ listId, taskId, taskData }` | Update a task |
| `completeTask` | `{ listId, taskId }` | Mark a task complete |
| `deleteTask` | `{ listId, taskId }` | Delete a task |
| `getListCounts` | `{ onlyIncomplete }` | Return task counts per list |

### Relevant Files

| File | Role |
|------|------|
| `src/bridge-server.js` | WebSocket server singleton; manages connections, dispatches requests |
| `src/providers/apple-bridge.js` | Provider class; implements the standard interface by forwarding to the bridge |
| `src/db/schema.sql` | `bridge_api_keys` table definition |
| `src/auth/userService.js` | `generateBridgeApiKey`, `getUserIdByBridgeApiKey`, `revokeBridgeApiKey`, `hasBridgeApiKey` |

### Bridge API Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/bridge/key` | Generate (or replace) the user's bridge API key |
| `DELETE` | `/auth/bridge/key` | Revoke the key and close any active connection |
| `GET` | `/auth/bridge/status` | Returns `{ hasKey: bool, connected: bool }` |

### Security Notes

- The raw API key is returned **once** at generation time and never stored. Only the SHA-256 hash is persisted.
- Revoking a key (`DELETE /auth/bridge/key`) immediately closes the active WebSocket connection.
- If a new key is generated while a bridge is connected, the old connection is closed before the new one is registered.
- Requests time out after 15 seconds if the local server does not respond (e.g., Mac is asleep).


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
