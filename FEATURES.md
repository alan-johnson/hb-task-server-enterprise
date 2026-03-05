# Feature Reference — Handsbreadth Task Server

A detailed breakdown of every feature in the server, with the benefit of each.

---

## Table of Contents

1. [Task Provider Integration](#1-task-provider-integration)
   - [Microsoft Tasks](#11-microsoft-tasks)
   - [Google Tasks](#12-google-tasks)
   - [Apple Reminders](#13-apple-reminders)
   - [Unified Provider Interface](#14-unified-provider-interface)
2. [Authentication & Security](#2-authentication--security)
3. [Multi-User Architecture](#3-multi-user-architecture)
4. [Caching](#4-caching)
5. [Web UI](#5-web-ui)
6. [REST API](#6-rest-api)
7. [User Preferences](#7-user-preferences)
8. [Deployment & Configuration](#8-deployment--configuration)

---

## 1. Task Provider Integration

### 1.1 Microsoft Tasks

Connects to Microsoft To Do via the Microsoft Graph API using OAuth 2.0 delegated permissions.

| Capability | Detail |
|---|---|
| OAuth flow | Authorization code flow — each user connects their own Microsoft account |
| List all task lists | Returns id, name, isOwner, isShared |
| Get tasks in a list | Returns id, name, completed, importance, dueDate, createdDate, lastUpdated, notes |
| Get task details | Full detail including categories |
| Create a task | Supports title, notes, due date, importance |
| Update a task | PATCH to Graph API — partial update; only fields present in the request body are sent |
| Delete a task | DELETE to Graph API |
| Mark task complete | Sets status to `completed` via PATCH |
| HTML body extraction | Notes returned as plain text — HTML tags and entities stripped automatically |
| Batch task counts | All list counts fetched in parallel (`Promise.all`) in a single endpoint call |

**Benefits:**
- Users connect their own Microsoft account — no admin credentials or delegated admin consent required for personal use
- `offline_access` scope ensures a refresh token is stored so the session can be restored
- `prompt: select_account` on the auth URL always shows the account picker, preventing the wrong account from being silently selected
- HTML stripping means clients receive clean plain text regardless of how the note was authored in Microsoft To Do

---

### 1.2 Google Tasks

Connects to Google Tasks via the Google Tasks API v1 using OAuth 2.0.

| Capability | Detail |
|---|---|
| OAuth flow | Authorization code flow with `access_type: offline` — refresh token is returned |
| List all task lists | Returns id, name, last updated timestamp |
| Get tasks in a list | Returns id, name, completed, notes, dueDate, position, last updated; includes completed and hidden tasks |
| Get task details | Full detail including parent task id and associated links |
| Create a task | Supports title, notes, due date |
| Update a task | Uses `tasks.patch` for partial updates — only fields present in the request are sent |
| Delete a task | `tasks.delete` — permanently removes the task |
| Mark task complete | Sets status to `completed` via update |
| Batch task counts | All list counts fetched in parallel |

**Benefits:**
- `access_type: offline` ensures a refresh token is issued at first authorization
- `showCompleted: true` and `showHidden: true` on task fetches means no data is silently omitted; clients can filter as needed
- `position` field returned so clients can preserve the user's manual sort order

---

### 1.3 Apple Reminders

Connects to the local Reminders app on macOS via AppleScript. No OAuth or cloud account required.

| Capability | Detail |
|---|---|
| List all reminder lists | Returns id, name |
| Get tasks in a list | Returns id, name, completed, notes, dueDate |
| Get task details | Full detail including createdDate |
| Create a task | Supports title, notes |
| Update a task | Sets name, notes, and due date via AppleScript; due date is converted from `YYYY-MM-DD` to `M/D/YYYY` format for AppleScript |
| Delete a task | `delete` command via AppleScript |
| Mark task complete | Sets completed property via AppleScript |
| Opt-in activation | Disabled by default; enabled with `ENABLE_APPLE_PROVIDER=true` |
| Non-blocking execution | AppleScript runs via async `execAsync` — does not block the Node.js event loop |
| Large buffer | `maxBuffer: 10 MB` to handle large Reminders libraries without truncation |
| String escaping | Special characters in task names and notes are escaped before being embedded in AppleScript |

**Benefits:**
- Zero OAuth setup — works out of the box on macOS with no external accounts or app registrations
- Tasks live entirely on the user's device, with no data sent to a third-party API
- Disabled by default prevents accidental activation on Linux or cloud servers where it would fail
- Async execution ensures one slow AppleScript call does not stall other requests

---

### 1.4 Unified Provider Interface

All three providers expose an identical method surface:

```
getLists()
getListCounts(onlyIncomplete)
getTasks(listId)
getTask(listId, taskId)
createTask(listId, taskData)
updateTask(listId, taskId, taskData)
completeTask(listId, taskId)
deleteTask(listId, taskId)
```

**Benefits:**
- The server routes never contain provider-specific logic — adding a new provider only requires implementing this interface
- Clients use the same API endpoints regardless of which provider is active; only the `?provider=` query parameter changes
- Task objects across all providers share a consistent shape (`id`, `name`, `completed`, `notes`, `dueDate`) with provider-specific fields added on top
- Full CRUD is available on all three providers through a single consistent API surface

---

## 2. Authentication & Security

### JWT Authentication

Tokens are signed with HS256 and expire after **30 days**.

| Endpoint | Description |
|---|---|
| `POST /auth/register` | Create account; returns a 30-day token immediately |
| `POST /auth/login` | Authenticate with username and password; returns a token |
| `POST /auth/refresh` | Exchange a valid token for a new 30-day token — no password required |
| `GET /auth/me` | Return the current user's profile using the token |

**Benefits:**
- Stateless — no server-side session store required; any instance can validate any token
- 30-day expiry keeps users logged in across normal usage patterns without re-prompting
- Proactive `/auth/refresh` endpoint lets clients renew tokens before expiry, so interactive users never hit an unexpected logout
- Token is attached to the request object (`req.user`) by middleware, so every protected route receives `userId` and `username` without additional database calls

### Password Hashing

Passwords are hashed with **bcrypt at 10 rounds** before storage.

**Benefits:**
- bcrypt is adaptive — work factor can be increased in the future without changing the API
- The salt is embedded in the hash, so no separate salt column is needed

### OAuth Token Encryption (AES-256-GCM)

Access tokens and refresh tokens are encrypted before being written to PostgreSQL.

| Property | Detail |
|---|---|
| Algorithm | AES-256-GCM |
| Key | 32-byte key from `ENCRYPTION_KEY` env var (64-character hex string) |
| IV | 12 random bytes, unique per encryption operation |
| Auth tag | 16 bytes, stored with ciphertext |
| Format | `iv_hex:authTag_hex:ciphertext_hex` stored as a single TEXT column |

**Benefits:**
- GCM mode provides both confidentiality and integrity — any tampering with the stored ciphertext causes decryption to fail with an authentication error
- A fresh random IV per encryption means identical tokens produce different ciphertext, preventing correlation attacks
- The encryption key lives only in the environment/secrets manager, not in the database — a database dump does not expose tokens
- Tokens are decrypted only in memory, only when an API call needs them

### Per-User Data Isolation

Every user has their own credential rows. Provider instances are created fresh per request and initialized with the requesting user's stored tokens.

**Benefits:**
- One user's tokens can never leak to another user's requests
- Users can connect different Microsoft or Google accounts independently
- Disconnecting a provider only removes that user's row; other users are unaffected

### Provider Status Validation

`GET /auth/providers/status` makes a live API call (`getLists()`) to each connected provider to confirm the stored token is actually valid.

**Benefits:**
- Clients know in real time whether a provider connection is working, not just whether a token row exists
- Cached for 5 minutes per user+provider to avoid hammering external APIs on every page load

---

## 3. Multi-User Architecture

### PostgreSQL Storage

All persistent state is stored in PostgreSQL. The schema is applied automatically on startup using `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

**Tables:**

| Table | Purpose |
|---|---|
| `users` | One row per registered user — credentials, preferences, default provider |
| `user_credentials` | One row per user per connected OAuth provider — encrypted tokens |

**Benefits:**
- Schema migrations run automatically on boot — no separate migration tool or manual step needed when columns are added
- Foreign key from `user_credentials` to `users` with `ON DELETE CASCADE` ensures no orphaned credential rows when a user is removed
- Unique index on `username` enforces uniqueness at the database level with a clear error code (`23505`) that the application maps to a user-readable message
- Connection pool (`max: 10`) handles concurrent requests efficiently without exhausting database connections

### Connection Pool

The `pg` connection pool is configured with:
- Maximum 10 connections
- Idle timeout: 30 seconds
- Connection timeout: 5 seconds

**Benefits:**
- Connections are reused across requests, avoiding the overhead of establishing a new connection per request
- The 5-second connection timeout causes the server to fail fast on database outages rather than hanging indefinitely

---

## 4. Caching

The server uses two independent cache layers that work in tandem.

### Redis Cache (optional, shared)

Activated by setting `REDIS_URL`. Caches user objects and OAuth credentials by key.

| Key | Value | Invalidated on |
|---|---|---|
| `user:id:{userId}` | JSON user object | `updateDefaultProvider`, `updatePreferences` |
| `user:name:{username}` | JSON user object | Same as above |
| `creds:{userId}:{provider}` | JSON credentials (decrypted) | `storeCredentials`, `removeCredentials` |

**Benefits:**
- Shared across all server instances — horizontal scaling does not cause cache misses between instances
- Redis errors are non-fatal and logged as warnings; if Redis is unavailable, reads fall back to PostgreSQL automatically
- Eliminates repeated database queries for user lookups and credential fetches, which happen on every authenticated request

### In-Memory TTL Cache (per instance)

A lightweight in-memory store (`SimpleCache`) with automatic TTL expiry. No external dependency required.

| Cache | TTL | Invalidated on |
|---|---|---|
| Provider status (`status:{userId}:{provider}`) | 5 minutes | Provider disconnect |
| Task lists (`lists:{userId}:{provider}`) | 2 minutes | — |
| Task counts (`counts:{userId}:{provider}:{flag}`) | 2 minutes | Provider disconnect, preferences change, task create, complete, delete |
| Tasks (`tasks:{userId}:{provider}:{listId}`) | 30 seconds | Task create, update, complete, delete |

**Benefits:**
- Dramatically reduces calls to external task APIs (Microsoft Graph, Google Tasks API, AppleScript) for frequently-visited data
- TTLs are tuned to the data's volatility — lists and counts change infrequently and can tolerate 2-minute staleness; task detail is fresher at 30 seconds
- No Redis required for single-instance deployments; caching still works entirely in memory
- Automatic key expiry (checked on get) prevents stale data from accumulating indefinitely

### Two-Layer Cache Interaction

```
Request arrives
  ├─ In-memory TTL cache hit → return immediately (no DB or Redis call)
  └─ In-memory miss
      ├─ Redis hit → return and optionally populate in-memory
      └─ Redis miss → query PostgreSQL → populate Redis and in-memory
```

---

## 5. Web UI

A browser-based interface served as static files from `src/public/` directly by the Express server. No separate web server or build step required.

### Login / Registration (`/`)

- Login and registration on a single page with a toggle link between forms
- Auto-redirects to the lists view if a valid token is already in `localStorage`
- Proper `autocomplete` attributes on all form inputs for browser password manager compatibility

### Lists View (`/lists.html`)

- Displays all task lists for the active provider
- Shows task count per list

### Tasks View (`/tasks.html`)

- Displays tasks within a selected list, split into incomplete and completed sections
- **Create** — "+ New Task" button opens a modal form (name, notes, due date); Enter submits, Escape cancels
- **Complete** — circle button on each incomplete task; turns green on hover; one click marks the task done
- **Edit** — "Edit" button (visible on hover) opens a pre-filled modal; all fields editable; due date cleared to `null` when the date field is emptied
- **Delete** — "Delete" button (visible on hover) opens a confirmation modal showing the task name; requires explicit confirmation before deletion
- Action buttons are hidden at rest and revealed on card hover (always visible on mobile)
- All mutations immediately invalidate the server-side cache and reload the task list

### Settings (`/settings.html`)

- Connect and disconnect Microsoft Tasks and Google Tasks via OAuth
- Displays live connection status for each provider
- Toggle the `showCompleted` preference
- Redirected to automatically after a successful OAuth callback (`?connected=microsoft` or `?connected=google`)

### Legal Pages

- `GET /privacy` — Privacy policy, served from `src/public/privacy.html`
- `GET /terms` — Terms of service, served from `src/public/terms.html`

**Benefits:**
- Clean `/privacy` and `/terms` URLs (not `/privacy.html`) satisfy OAuth app registration requirements for Google and Microsoft
- No build tool, bundler, or framework — the UI is plain HTML/CSS/JS and works immediately without a build step
- Static files served by the same Express process — no separate web server to configure or proxy

---

## 6. REST API

### Authentication Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | No | Register a new user; returns a 30-day JWT |
| `POST` | `/auth/login` | No | Log in; returns a 30-day JWT |
| `POST` | `/auth/refresh` | Yes | Issue a new 30-day token from a valid existing token |
| `GET` | `/auth/me` | Yes | Return the current user's profile |
| `GET` | `/auth/providers/status` | Yes | Live connection check for all providers |
| `GET` | `/auth/microsoft/url` | Yes | Generate a Microsoft OAuth authorization URL |
| `GET` | `/auth/microsoft/callback` | — | Microsoft OAuth callback; stores tokens and redirects |
| `POST` | `/auth/microsoft/token` | Yes | Store a Microsoft access token manually (fallback) |
| `GET` | `/auth/google/url` | Yes | Generate a Google OAuth authorization URL |
| `GET` | `/auth/google/callback` | — | Google OAuth callback; stores tokens and redirects |
| `DELETE` | `/auth/provider/:provider` | Yes | Disconnect a provider and remove its stored credentials |
| `PATCH` | `/auth/default-provider` | Yes | Update the user's default provider |
| `PATCH` | `/auth/preferences` | Yes | Update user preferences (`showCompleted`) |

### Task Endpoints

All task endpoints require a `Bearer` token. The provider is selected by `?provider=` query parameter, falling back to the user's `defaultProvider`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/lists` | All task lists for the active provider |
| `GET` | `/api/lists/counts` | Task counts for all lists in a single call |
| `GET` | `/api/lists/:listId/tasks` | All tasks in a list |
| `GET` | `/api/lists/:listId/tasks/:taskId` | Single task detail |
| `POST` | `/api/lists/:listId/tasks` | Create a new task |
| `PATCH` | `/api/lists/:listId/tasks/:taskId` | Update a task (name, notes, due date) |
| `PATCH` | `/api/lists/:listId/tasks/:taskId/complete` | Mark a task as complete |
| `DELETE` | `/api/lists/:listId/tasks/:taskId` | Delete a task permanently |

### Other

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check — returns `{ status: "ok", timestamp }` |
| `GET` | `/api/providers` | List enabled providers and the default |
| `GET` | `/privacy` | Privacy policy page |
| `GET` | `/terms` | Terms of service page |

### Batch Counts Endpoint

`GET /api/lists/counts` fetches the task count for every list in a single HTTP call. Internally, each list's tasks are fetched in parallel using `Promise.all`.

**Benefits:**
- Eliminates N+1 requests (one per list) from the client — a single call replaces the pattern of GET /api/lists followed by N × GET /api/lists/:id/tasks
- Respects the `showCompleted` preference server-side — completed tasks are excluded from counts without the client doing any filtering
- Results are cached for 2 minutes per user+provider, so repeated calls from the web UI are served from memory

### Update Endpoint

`PATCH /api/lists/:listId/tasks/:taskId` accepts a partial body — only fields included in the request are updated.

```json
{ "name": "Revised title", "notes": "Updated notes", "dueDate": "2026-04-01" }
```

Pass `"dueDate": null` to explicitly clear a due date. Invalidates the task list cache on success.

### Delete Endpoint

`DELETE /api/lists/:listId/tasks/:taskId` permanently removes the task from the provider. Invalidates both the task list cache and the counts cache on success.

**Benefits of separating update from complete:**
- Allows editing the name, notes, or due date of a task without changing its completion state
- Completion remains a dedicated one-way action (`/complete`), making it harder to accidentally un-complete a task through a generic update

---

## 7. User Preferences

### Default Provider

Each user has a `defaultProvider` field (`microsoft`, `google`, or `apple`). Used as the fallback when `?provider=` is not specified in a request.

**Benefits:**
- Clients that don't specify a provider always get a meaningful response without error
- Can be changed at any time via `PATCH /auth/default-provider`

### Show Completed

The `showCompleted` boolean preference controls whether completed tasks are included in the counts returned by `/api/lists/counts`. Default is `false`.

**Benefits:**
- Users who want a clean count of remaining work see only incomplete tasks
- Users who want a full picture can opt in
- Preference is stored per user in PostgreSQL and respected server-side — clients need no filtering logic

---

## 8. Deployment & Configuration

### Flexible Port

Default port is `3500`. Override with the `PORT` environment variable.

### Apple Provider Feature Flag

`ENABLE_APPLE_PROVIDER=false` by default. Apple Reminders requires macOS and is deliberately disabled so it cannot accidentally activate on a Linux server.

**Benefits:**
- Safe default for cloud deployments — AppleScript would fail silently or with cryptic errors on Linux; the flag makes the problem explicit and configurable
- Local macOS developers can enable it with a single env var change

### Default Provider Flag

`DEFAULT_PROVIDER` sets the provider returned by `/api/providers` and used as the fallback for new users. Defaults to `microsoft`.

### Auto Schema Migration

On startup, the server runs the full `schema.sql` using `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. New columns added to the schema are applied automatically on next boot.

**Benefits:**
- No migration tooling required
- Safe to run on an existing database — existing tables and data are not affected
- Deploying a new version is a simple `git pull && npm start`

### Single Binary Entry Point

`npm start` runs `node src/server.js`. No build step, no transpilation, no compilation.

**Benefits:**
- Deployment is as simple as `npm install --omit=dev && npm start`
- Works with any Node.js 18+ runtime without additional tooling

### CORS Enabled

`cors()` middleware is applied globally.

**Benefits:**
- Web UIs served from a different origin (e.g., a CDN or different subdomain) can call the API without browser CORS errors
- Supports integration with mobile webviews and third-party clients
