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

Tasks are classified into three buckets — see `docs/triage-engine-implementation-plan.md` for the full design. Two rule shapes are accepted:

- **Legacy** (no `schemaVersion`, or `schemaVersion: 1`) — two booleans plus a priority list per bucket:

  | Bucket | Default criteria |
  |--------|-----------------|
  | `now` | Overdue or high priority |
  | `next` | Future due date or normal priority |
  | `later` | Everything else |

- **`schemaVersion: 2`** (recommended) — an AND/OR/NOT predicate tree over `dueDate`/`priority`/`tags`/`listId`/`ageDays`, letting a rule express things the legacy shape can't (e.g. "high priority AND due within 3 days"). This is the system-wide default shape as of `V4__system_default_to_predicate_tree.sql`. See the schema at `GET /schemas/classification-rules.schema.json` for the full grammar, and [Editing rules in VS Code](#editing-classification-rules-in-vs-code) below for the recommended workflow.

Classification is applied automatically to all task responses. Each task includes `"classification"` and `"classificationReason"` fields.

### Get classification rules 🔒
```
GET /auth/me/classification
```
```json
{ "rules": { "schemaVersion": 2, "now": {...}, "next": {...}, "later": {...} }, "isCustom": false }
```

---

### Save custom classification rules 🔒
```
PUT /auth/me/classification
```
**Body** (schemaVersion:2 example)
```json
{
  "schemaVersion": 2,
  "now":   { "any": [{ "field": "dueDate", "op": "overdue" }, { "field": "priority", "op": "eq", "value": "high" }] },
  "next":  { "any": [{ "field": "dueDate", "op": "future_due" }, { "field": "priority", "op": "eq", "value": "normal" }] },
  "later": {}
}
```
A top-level `$schema` field, if present, is ignored (stripped before validation) — so the file `GET /auth/me/classification/export` produces can be PUT back unmodified.

---

### Reset classification rules to server defaults 🔒
```
DELETE /auth/me/classification
```

---

### List starter presets 🔒
```
GET /auth/me/classification/presets
```
Returns named `schemaVersion:2` starting points (`gtd`, `eisenhower`, `support_triage`) with a label/description. Applying one is just `PUT /auth/me/classification` with its `rules` value.

---

### Dry-run a candidate ruleset 🔒
```
POST /auth/me/classification/preview
```
**Body**: `{ "rules": {...} }` — classifies your *current real tasks* against a candidate ruleset without saving it. Response shape matches `GET /api/tasks/unified`.

---

### Export classification rules 🔒
```
GET /auth/me/classification/export
```
Returns your effective rules (custom, or the system default if you haven't set any) with a `$schema` field pointing at the served JSON Schema, and a `Content-Disposition` header so a browser downloads it as `classification-rules.json`.
```json
{
  "$schema": "https://tasks.handsbreadth.com/schemas/classification-rules.schema.json",
  "schemaVersion": 2,
  "now":   { "any": [{ "field": "dueDate", "op": "overdue" }, { "field": "priority", "op": "eq", "value": "high" }] },
  "next":  { "any": [{ "field": "dueDate", "op": "future_due" }, { "field": "priority", "op": "eq", "value": "normal" }] },
  "later": {}
}
```

---

### Validate classification rules before importing 🔒
```
POST /auth/me/classification/validate
```
Checks a rules payload the same way `PUT` does, without saving it. Always `200` — a validation failure isn't a request failure.
**Body**: the rules object (a top-level `$schema` field, if present, is ignored).
```json
{ "valid": true, "rules": { "schemaVersion": 2, "now": {...}, "next": {...}, "later": {...} } }
```
```json
{ "valid": false, "errors": [{ "path": "now.op", "message": "Invalid enum value..." }] }
```

---

### Parse and validate TOML classification rules 🔒
```
POST /auth/me/classification/parse
```
Validates a TOML string and returns the parsed **legacy-shape** rules without saving — TOML only supports the legacy shape, not `schemaVersion: 2` predicate trees. For the predicate-tree workflow, use `.../export` and `.../validate` above instead.
**Body**
```json
{ "toml": "[now]\nlabel = \"Now\"\noverdue = true\npriorities = [\"high\"]\n..." }
```

---

### Editing classification rules in VS Code

The recommended workflow for hand-editing a `schemaVersion: 2` predicate tree — export, edit with schema-assisted autocomplete, validate, re-import:

1. **Export**: `GET /auth/me/classification/export` and save the response as a `.json` file (or use Settings → Danger Zone → Classification Rules → Export in the browser UI, which does this for you).
2. **Edit in VS Code**: open the file. Because it includes a `"$schema"` field pointing at `/schemas/classification-rules.schema.json`, VS Code's built-in JSON language support automatically gives you autocomplete for `field`/`op` values, inline red-squiggly errors for typos (e.g. a bad `op`, or a predicate node with a missing `schemaVersion: 2` at the top level), and hover documentation for each part of the grammar — no extension or editor config needed.
3. **Validate**: `POST /auth/me/classification/validate` with the file's contents as the body (the `$schema` field is ignored automatically, no need to remove it). Returns `{"valid": true, "rules": {...}}` or `{"valid": false, "errors": [...]}` — fix anything reported and re-check before moving on.
4. **Import**: once valid, `PUT /auth/me/classification` with the same file contents to actually save it. (In the browser UI, picking a file in the Import button runs the validate step automatically and shows the result before you confirm.)

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
Fetches tasks from all connected providers and annotates each with `classification`. Accepts `Authorization: Bearer` as either a JWT or a [developer API key](#developer-api-keys--mcp-beta).

Optional query params:
| Param | Description |
|---|---|
| `list_id` | Comma-separated list IDs — only include tasks from these lists |
| `exclude_list` | Comma-separated list IDs — omit tasks from these lists |
| `limit`, `offset` | Paginate the (already filtered) result; response adds `total`/`hasMore` |
| `sort=classification` | Sort tasks Now → Next → Later |

```json
{
  "user": "alice",
  "tasks": [
    { "id": "...", "name": "...", "provider": "microsoft", "listId": "...", "listName": "Work", "classification": "now" },
    { "id": "...", "name": "...", "provider": "apple", "listId": "...", "listName": "Personal", "classification": "later" }
  ],
  "total": 9,
  "hasMore": false
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

## Developer API Keys / MCP (beta) [enterprise only]

See the **[Developer Quickstart](./quickstart.md)** for a walkthrough. This section is the reference.

`/api/tasks/unified`, `/api/lists*`, `/api/tasks*`, and `/auth/me/classification*` all accept `Authorization: Bearer` as either a JWT **or** a developer API key (`upq_live_...` / `upq_sandbox_...`). A `upq_sandbox_` key can only ever see sandbox (seeded, fake) data, regardless of the account's real connected providers. Neither key type can access billing or account-management routes — those remain JWT-only.

### Create an API key 🔒 (JWT only)
```
POST /auth/api-keys
{ "name": "my-key", "sandbox": false, "scopes": ["tasks:read", "tasks:write"] }
```
Raw key is returned **once** — store it immediately. `scopes` is optional (array or comma-separated string); omit it for the default full `tasks:read,tasks:write`, or pass `["tasks:read"]` to mint a read-only key. Unknown scope values return `400 invalid_request`.
```json
{ "id": "...", "apiKey": "upq_live_...", "prefix": "upq_live_...", "sandbox": false, "scopes": "tasks:read,tasks:write", "createdAt": "..." }
```

Scopes are enforced, not just recorded: `GET`/`HEAD` requests need `tasks:read`; every other method needs `tasks:write`. A key missing the required scope gets `403 forbidden`. `POST /mcp` itself is exempt from this check (it multiplexes read and write MCP tools behind one HTTP method) — the underlying REST call each tool makes is scoped as usual, so a read-only key can call `get_triage` over MCP but gets a tool-level `isError` on `set_rules`.

### List API keys 🔒 (JWT only)
```
GET /auth/api-keys
```
Returns metadata only — never the raw key or its hash.

### Revoke an API key 🔒 (JWT only)
```
DELETE /auth/api-keys/:id
```

### Reset sandbox data 🔒 (sandbox key only)
```
POST /api/sandbox/reset
```
Reverts that key's in-memory sandbox tasks back to the seeded fixture baseline. State is process-local and not guaranteed to survive a server restart.

### Idempotency
Send an `Idempotency-Key` header on any task write — `POST /api/lists/:listId/tasks` (create), `PATCH .../tasks/:taskId` (update), `PATCH .../tasks/:taskId/complete`, or `DELETE .../tasks/:taskId`. Same key + same request body replays the original response instead of repeating the write. Same key + a different body returns `400 invalid_request`.

### Rate limiting
Routes above are limited to 120 requests/minute per account (shared across all keys and JWT sessions), keyed by user, not IP. Exceeding it returns `429` in the unified error shape.

### Unified error shape
Routes in this section (and MCP tool error results) use:
```json
{ "error": { "code": "rate_limited", "message": "..." } }
```
Codes: `unauthorized` (401), `forbidden` (403), `invalid_request` (400), `not_found` (404), `rate_limited` (429), `subscription_required` (402), `provider_error` (502), `internal_error` (500). Other routes in this API predate this and keep their original `{"error": "..."}` string shape.

### MCP server
Tools `get_triage`, `get_rules`, `set_rules` wrap the routes above. Two transports, same tools:
- **Stdio**: `UPQ_API_BASE_URL=... UPQ_API_KEY=... node src/mcp-server.js` (or `npm run start:mcp`) — run locally by the developer.
- **Hosted (Streamable HTTP)**: `POST /mcp`, authenticated the same way as REST (`Authorization: Bearer upq_...`).

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

🔒 = JWT required. 🔒/🔑 = JWT **or** [developer API key](#developer-api-keys--mcp-beta) accepted.

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
| `GET` | `/auth/me/classification` | 🔒/🔑 | Get classification rules |
| `PUT` | `/auth/me/classification` | 🔒/🔑 | Save custom rules |
| `DELETE` | `/auth/me/classification` | 🔒/🔑 | Reset to server defaults |
| `POST` | `/auth/me/classification/parse` | 🔒/🔑 | Parse TOML rules (no save) |
| `GET` | `/api/lists` | 🔒/🔑 | Get lists (single provider) |
| `GET` | `/api/lists/all` | 🔒/🔑 | Get lists (all providers) |
| `GET` | `/api/lists/counts` | 🔒/🔑 | Task counts per list |
| `GET` | `/api/lists/:listId/tasks` | 🔒/🔑 | Get tasks in a list |
| `GET` | `/api/lists/:listId/tasks/:taskId` | 🔒/🔑 | Get a single task |
| `POST` | `/api/lists/:listId/tasks` | 🔒/🔑 | Create a task |
| `PATCH` | `/api/lists/:listId/tasks/:taskId` | 🔒/🔑 | Update a task |
| `PATCH` | `/api/lists/:listId/tasks/:taskId/complete` | 🔒/🔑 | Complete a task |
| `DELETE` | `/api/lists/:listId/tasks/:taskId` | 🔒/🔑 | Delete a task |
| `GET` | `/api/tasks/unified` | 🔒/🔑 | All tasks across all providers |
| `POST` | `/auth/bridge/key` | 🔒 | Generate bridge API key |
| `DELETE` | `/auth/bridge/key` | 🔒 | Revoke bridge API key |
| `GET` | `/auth/bridge/status` | 🔒 | Bridge connection status |
| `POST` | `/auth/api-keys` | 🔒 | Create a developer API key |
| `GET` | `/auth/api-keys` | 🔒 | List developer API keys |
| `DELETE` | `/auth/api-keys/:id` | 🔒 | Revoke a developer API key |
| `POST` | `/api/sandbox/reset` | 🔑 (sandbox) | Reset sandbox data to fixture baseline |
| `POST` | `/mcp` | 🔒/🔑 | Hosted MCP server (Streamable HTTP) |
| `GET` | `/billing/status` | 🔒 | Subscription status |
| `POST` | `/billing/create-checkout-session` | 🔒 | Create Stripe Checkout session |
| `GET` | `/billing/session-info` | 🔒 | Checkout session details |
| `POST` | `/billing/cancel-subscription` | 🔒 | Schedule cancellation |
| `POST` | `/billing/switch-to-monthly` | 🔒 | Downgrade to monthly |
| `POST` | `/billing/webhook` | — | Stripe webhook (internal) |
