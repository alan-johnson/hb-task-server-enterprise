# Handsbreadth Task Server — REST API Reference

This document covers the REST APIs for both servers:

| Server | Description |
|--------|-------------|
| **hb-task-server** | Local macOS server. Exposes Apple Reminders over HTTP. No authentication. |
| **hb-task-server-enterprise** | Cloud server. Multi-user, JWT-authenticated. Supports Microsoft To Do, Google Tasks, and Apple Reminders (via bridge). |

Endpoints marked **[local only]** exist only in `hb-task-server`. Endpoints marked **[enterprise only]** exist only in `hb-task-server-enterprise`. Unmarked endpoints exist in both servers.

---

## Authentication

`hb-task-server` has **no authentication**. All endpoints are public.

`hb-task-server-enterprise` uses **JWT Bearer tokens**. Endpoints marked `🔒` require:

```
Authorization: Bearer <jwt-token>
```

Tokens are obtained from `POST /auth/login` or `GET /auth/verify-email`.

---

## Providers

### hb-task-server

| Provider | Mechanism |
|----------|-----------|
| `apple` | AppleScript (default) |
| `reminders-cli` | CLI binary |

All endpoints accept an optional `?provider=apple\|reminders-cli` query parameter. If omitted, `DEFAULT_PROVIDER` from `.env` is used.

### hb-task-server-enterprise

| Provider | Mechanism |
|----------|-----------|
| `microsoft` | Microsoft To Do via OAuth (default) |
| `google` | Google Tasks via OAuth |
| `apple` | Apple Reminders via hb-task-server bridge |

All task/list endpoints accept an optional `?provider=microsoft\|google\|apple` query parameter. If omitted, the user's `defaultProvider` preference is used.

---

## Health

### Health check
```
GET /health
```
**Response**
```json
{ "status": "ok", "timestamp": "2026-03-20T12:00:00.000Z" }
```

---

## Providers

### List available providers
```
GET /api/providers
```
**hb-task-server response**
```json
{ "providers": ["apple", "reminders-cli"], "default": "apple" }
```
**hb-task-server-enterprise response**
```json
{ "providers": ["microsoft", "google"], "default": "microsoft" }
```

> Note: `apple` is not listed in the enterprise `/api/providers` response even when a bridge is connected. It is available as a provider value in task/list endpoints when a bridge session is active.

---

## Authentication Routes [enterprise only]

### Register a new account
```
POST /auth/register
```
**Body**
```json
{ "username": "alice", "password": "s3cur3!", "email": "alice@example.com" }
```
**Response** `201`
```json
{ "message": "Account created. Please check your email to verify your address." }
```
A verification email is sent. The account cannot log in until verified.

---

### Log in
```
POST /auth/login
```
**Body**
```json
{ "username": "alice", "password": "s3cur3!" }
```
**Response** `200`
```json
{ "message": "Login successful", "user": { ... }, "token": "<jwt>" }
```
**Error** `403` if email is not yet verified (`"code": "EMAIL_NOT_VERIFIED"`).

---

### Verify email address
```
GET /auth/verify-email?token=<verification-token>
```
Validates the email token and redirects the browser to `/pricing.html#token=<jwt>`.
The JWT in the URL fragment can be used immediately without another login.

---

### Resend verification email
```
POST /auth/resend-verification
```
**Body**
```json
{ "username": "alice" }
```
Always returns a generic success message to prevent username enumeration.

---

### Request a password reset
```
POST /auth/forgot-password
```
**Body**
```json
{ "email": "alice@example.com" }
```
Always returns a generic response. A reset link is emailed if the address is registered.

---

### Reset password
```
POST /auth/reset-password
```
**Body**
```json
{ "token": "<reset-token>", "newPassword": "newS3cur3!" }
```
Password must be at least 8 characters.

---

### Get current user 🔒
```
GET /auth/me
```
**Response**
```json
{ "user": { "userId": "...", "username": "alice", "email": "...", "defaultProvider": "microsoft", "showCompleted": false } }
```

---

### Refresh JWT token 🔒
```
POST /auth/refresh
```
Issues a fresh JWT for the authenticated user.
```json
{ "token": "<new-jwt>" }
```

---

### Get provider connection status 🔒
```
GET /auth/providers/status
```
Makes a live API call to each connected provider to verify the token still works.
```json
{ "microsoft": true, "google": false, "apple": true }
```

---

### Get stored credentials status 🔒
```
GET /auth/providers/authorized
```
Checks whether credentials are stored — no live API call.
```json
{ "microsoft": true, "google": false }
```

---

### Update show-completed preference 🔒
```
PATCH /auth/preferences
```
**Body**
```json
{ "showCompleted": true }
```

---

### Set default provider 🔒
```
PATCH /auth/default-provider
```
**Body**
```json
{ "provider": "google" }
```
Valid values: `microsoft`, `google`, `apple`.

---

## OAuth — Google [enterprise only]

### Get Google OAuth URL 🔒
```
GET /auth/google/url
```
**Response**
```json
{ "authUrl": "https://accounts.google.com/o/oauth2/auth?..." }
```
Redirect the user's browser to `authUrl` to begin the OAuth flow.

---

### Google OAuth callback
```
GET /auth/google/callback?code=...&state=...
```
Handled automatically by the browser redirect. Stores tokens and redirects to `/settings.html?connected=google`.

---

## OAuth — Microsoft [enterprise only]

### Get Microsoft OAuth URL 🔒
```
GET /auth/microsoft/url
```
**Response**
```json
{ "authUrl": "https://login.microsoftonline.com/..." }
```

---

### Microsoft OAuth callback
```
GET /auth/microsoft/callback?code=...&state=...
```
Stores tokens and redirects to `/settings.html?connected=microsoft`.

---

### Store Microsoft token directly 🔒
```
POST /auth/microsoft/token
```
Alternative to the OAuth flow — store a token obtained externally.
**Body**
```json
{ "accessToken": "<token>" }
```

---

### Disconnect a provider 🔒
```
DELETE /auth/provider/:provider
```
Removes stored credentials for `microsoft` or `google`. Clears related caches.

---

## Settings [enterprise only]

### Get all user settings 🔒
```
GET /api/settings
```
Returns user preferences, provider connection states, bridge status, and classification rules in a single call.
```json
{
  "user": { "username": "alice", "email": "...", "defaultProvider": "microsoft", "showCompleted": false },
  "providers": { "microsoft": true, "google": false, "apple": false },
  "bridge": { "hasKey": true, "connected": false },
  "classification": { "rules": { ... }, "isCustom": false }
}
```

---

### Update user settings 🔒
```
PATCH /api/settings
```
**Body** (all fields optional)
```json
{ "defaultProvider": "google", "showCompleted": true }
```

---

## Task Classification [enterprise only]

Tasks are classified into three buckets based on due date and priority:

| Bucket | Default criteria |
|--------|-----------------|
| `now` | Overdue or high priority |
| `not_now` | Future due date or normal priority |
| `later` | Everything else |

Classification is applied automatically to all task responses. Each task includes a `"classification"` field.

### Get classification rules 🔒
```
GET /auth/me/classification
```
```json
{ "rules": { "now": {...}, "not_now": {...}, "later": {...} }, "isCustom": false }
```

---

### Save custom classification rules 🔒
```
PUT /auth/me/classification
```
**Body**
```json
{
  "now":     { "label": "Now",     "overdue": true,  "priorities": ["high"] },
  "not_now": { "label": "Not Now", "future_due": true, "priorities": ["normal"] },
  "later":   { "label": "Later" }
}
```

---

### Reset classification rules to server defaults 🔒
```
DELETE /auth/me/classification
```

---

### Parse and validate TOML classification rules 🔒
```
POST /auth/me/classification/parse
```
Validates a TOML string and returns the parsed rules without saving.
**Body**
```json
{ "toml": "[now]\nlabel = \"Now\"\noverdue = true\npriorities = [\"high\"]\n..." }
```

---

## Task Lists

### Get all lists (single provider)
```
GET /api/lists
GET /api/lists?provider=reminders-cli        # hb-task-server
GET /api/lists?provider=google               # enterprise
```
**hb-task-server response**
```json
[{ "id": "list-id", "name": "Groceries" }, ...]
```
**hb-task-server-enterprise response** `🔒`
```json
{ "provider": "microsoft", "user": "alice", "lists": [{ "id": "...", "name": "Groceries" }] }
```

---

### Get lists from all connected providers [enterprise only] 🔒
```
GET /api/lists/all
```
```json
{
  "user": "alice",
  "providers": ["microsoft", "google"],
  "byProvider": { "microsoft": [...], "google": [...] },
  "lists": [{ "id": "...", "name": "...", "provider": "microsoft" }, ...]
}
```

---

### Get task counts per list [enterprise only] 🔒
```
GET /api/lists/counts
GET /api/lists/counts?provider=google
```
Respects the user's `showCompleted` preference when counting.
```json
{ "provider": "microsoft", "counts": { "list-id-1": 3, "list-id-2": 0 } }
```

---

## Tasks

### Get tasks in a list
```
GET /api/lists/:listId/tasks
GET /api/lists/:listId/tasks?showCompleted=true&limit=100   # hb-task-server
GET /api/lists/:listId/tasks?provider=google               # enterprise
```
**hb-task-server response**
```json
[{ "id": "task-id", "name": "Buy milk", "completed": false, "dueDate": "2026-03-21" }, ...]
```
**hb-task-server-enterprise response** `🔒`
```json
{
  "provider": "microsoft",
  "user": "alice",
  "listId": "list-id",
  "tasks": [{ "id": "...", "name": "Buy milk", "classification": "now", ... }]
}
```

---

### Get a single task
```
GET /api/lists/:listId/tasks/:taskId
```
**hb-task-server response**
```json
{ "id": "task-id", "name": "Buy milk", "completed": false }
```
**hb-task-server-enterprise response** `🔒`
```json
{ "provider": "microsoft", "user": "alice", "listId": "...", "task": { ..., "classification": "not_now" } }
```

---

### Create a task
```
POST /api/lists/:listId/tasks
Content-Type: application/json
```
**Body**
```json
{
  "name": "Buy milk",
  "notes": "2% please",
  "dueDate": "2026-03-21"
}
```
**hb-task-server response** `201`
```json
{ "id": "new-task-id", "name": "Buy milk" }
```
**hb-task-server-enterprise response** `🔒` `201`
```json
{ "provider": "microsoft", "user": "alice", "listId": "...", "task": { ... } }
```

---

### Update a task [enterprise only] 🔒
```
PATCH /api/lists/:listId/tasks/:taskId
Content-Type: application/json
```
**Body** (all fields optional)
```json
{ "name": "Buy oat milk", "dueDate": "2026-03-22", "priority": "high", "notes": "updated" }
```
**Response**
```json
{ "provider": "microsoft", "user": "alice", "listId": "...", "taskId": "..." }
```

---

### Complete a task
```
PATCH /api/lists/:listId/tasks/:taskId/complete
```
**hb-task-server** — no body required.
**hb-task-server-enterprise** `🔒` — no body required.

---

### Delete a task [enterprise only] 🔒
```
DELETE /api/lists/:listId/tasks/:taskId
```

---

### Get unified task list (all providers) [enterprise only] 🔒
```
GET /api/tasks/unified
```
Fetches tasks from all connected providers and annotates each with `classification`.
```json
{
  "user": "alice",
  "tasks": [
    { "id": "...", "name": "...", "provider": "microsoft", "listId": "...", "listName": "Work", "classification": "now" },
    { "id": "...", "name": "...", "provider": "apple", "listId": "...", "listName": "Personal", "classification": "later" }
  ]
}
```

---

## Bridge — Apple Reminders via hb-task-server [enterprise only]

The bridge allows the enterprise server to proxy requests to a user's local `hb-task-server` instance over a persistent WebSocket. The local server initiates the outbound connection — no inbound firewall rules are required.

### Generate a bridge API key 🔒
```
POST /auth/bridge/key
```
Issues a new API key (replaces any existing key). The key is shown **only once** — copy it immediately.
```json
{ "apiKey": "hb_...", "message": "Store this key in your hb-task-server .env as BRIDGE_API_KEY." }
```

---

### Revoke the bridge API key 🔒
```
DELETE /auth/bridge/key
```
Revokes the key and closes any active bridge WebSocket connection.

---

### Get bridge status 🔒
```
GET /auth/bridge/status
```
```json
{ "hasKey": true, "connected": true }
```

---

## Billing (Stripe) [enterprise only]

Requires Stripe to be configured (`STRIPE_SECRET_KEY`). Returns `503` if billing is not configured.

### Get subscription status 🔒
```
GET /billing/status
```
```json
{
  "subscriptionStatus": "active",
  "plan": "monthly",
  "currentPeriodEnd": "2026-04-20T00:00:00.000Z",
  "cancelAtPeriodEnd": false
}
```

---

### Create a Stripe Checkout session 🔒
```
POST /billing/create-checkout-session
```
**Body**
```json
{ "plan": "monthly" }
```
Valid plan values: `monthly`, `annual`, `trial`.
```json
{ "url": "https://checkout.stripe.com/..." }
```
Redirect the user's browser to `url` to complete payment.

---

### Get checkout session info 🔒
```
GET /billing/session-info?session_id=<stripe-session-id>
```
```json
{
  "plan": "annual",
  "status": "active",
  "trialEnd": null,
  "currentPeriodEnd": "2027-03-20T00:00:00.000Z"
}
```

---

### Cancel subscription 🔒
```
POST /billing/cancel-subscription
```
Schedules cancellation at the end of the current billing period (does not cancel immediately).
```json
{ "cancelAtPeriodEnd": true, "currentPeriodEnd": "2026-04-20T00:00:00.000Z" }
```

---

### Switch annual plan to monthly 🔒
```
POST /billing/switch-to-monthly
```
Downgrades at the next renewal with no proration. Returns `400` if already on monthly.
```json
{ "currentPeriodEnd": "2027-03-20T00:00:00.000Z" }
```

---

### Stripe webhook (internal)
```
POST /billing/webhook
```
Stripe-signed webhook endpoint. Not called by API clients — registered with Stripe directly.
Requires `stripe-signature` header and `STRIPE_WEBHOOK_SECRET` env var.

---

## Quick Reference

### hb-task-server (local, no auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/providers` | List providers |
| `GET` | `/api/lists` | Get all lists |
| `GET` | `/api/lists/:listId/tasks` | Get tasks in a list |
| `GET` | `/api/lists/:listId/tasks/:taskId` | Get a single task |
| `POST` | `/api/lists/:listId/tasks` | Create a task |
| `PATCH` | `/api/lists/:listId/tasks/:taskId/complete` | Complete a task |

### hb-task-server-enterprise (cloud, JWT auth)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Health check |
| `GET` | `/api/providers` | — | List providers |
| `POST` | `/auth/register` | — | Register account |
| `POST` | `/auth/login` | — | Login, get JWT |
| `GET` | `/auth/verify-email` | — | Verify email (link from email) |
| `POST` | `/auth/resend-verification` | — | Resend verification email |
| `POST` | `/auth/forgot-password` | — | Request password reset |
| `POST` | `/auth/reset-password` | — | Reset password with token |
| `GET` | `/auth/me` | 🔒 | Get current user |
| `POST` | `/auth/refresh` | 🔒 | Refresh JWT |
| `GET` | `/auth/providers/status` | 🔒 | Live provider status |
| `GET` | `/auth/providers/authorized` | 🔒 | Stored credentials check |
| `PATCH` | `/auth/preferences` | 🔒 | Update showCompleted |
| `PATCH` | `/auth/default-provider` | 🔒 | Set default provider |
| `GET` | `/auth/google/url` | 🔒 | Get Google OAuth URL |
| `GET` | `/auth/google/callback` | — | Google OAuth callback |
| `GET` | `/auth/microsoft/url` | 🔒 | Get Microsoft OAuth URL |
| `GET` | `/auth/microsoft/callback` | — | Microsoft OAuth callback |
| `POST` | `/auth/microsoft/token` | 🔒 | Store Microsoft token directly |
| `DELETE` | `/auth/provider/:provider` | 🔒 | Disconnect provider |
| `GET` | `/api/settings` | 🔒 | Get all user settings |
| `PATCH` | `/api/settings` | 🔒 | Update user settings |
| `GET` | `/auth/me/classification` | 🔒 | Get classification rules |
| `PUT` | `/auth/me/classification` | 🔒 | Save custom rules |
| `DELETE` | `/auth/me/classification` | 🔒 | Reset to server defaults |
| `POST` | `/auth/me/classification/parse` | 🔒 | Parse TOML rules (no save) |
| `GET` | `/api/lists` | 🔒 | Get lists (single provider) |
| `GET` | `/api/lists/all` | 🔒 | Get lists (all providers) |
| `GET` | `/api/lists/counts` | 🔒 | Task counts per list |
| `GET` | `/api/lists/:listId/tasks` | 🔒 | Get tasks in a list |
| `GET` | `/api/lists/:listId/tasks/:taskId` | 🔒 | Get a single task |
| `POST` | `/api/lists/:listId/tasks` | 🔒 | Create a task |
| `PATCH` | `/api/lists/:listId/tasks/:taskId` | 🔒 | Update a task |
| `PATCH` | `/api/lists/:listId/tasks/:taskId/complete` | 🔒 | Complete a task |
| `DELETE` | `/api/lists/:listId/tasks/:taskId` | 🔒 | Delete a task |
| `GET` | `/api/tasks/unified` | 🔒 | All tasks across all providers |
| `POST` | `/auth/bridge/key` | 🔒 | Generate bridge API key |
| `DELETE` | `/auth/bridge/key` | 🔒 | Revoke bridge API key |
| `GET` | `/auth/bridge/status` | 🔒 | Bridge connection status |
| `GET` | `/billing/status` | 🔒 | Subscription status |
| `POST` | `/billing/create-checkout-session` | 🔒 | Create Stripe Checkout session |
| `GET` | `/billing/session-info` | 🔒 | Checkout session details |
| `POST` | `/billing/cancel-subscription` | 🔒 | Schedule cancellation |
| `POST` | `/billing/switch-to-monthly` | 🔒 | Downgrade to monthly |
| `POST` | `/billing/webhook` | — | Stripe webhook (internal) |
