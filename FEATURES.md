# Feature Reference — UpQ task server

A detailed breakdown of every feature in the server, with the benefit of each.

---

## Table of Contents

1. [Task Provider Integration](#1-task-provider-integration)
   - [Microsoft Tasks](#11-microsoft-tasks)
   - [Google Tasks](#12-google-tasks)
   - [Unified Provider Interface](#13-unified-provider-interface)
2. [Authentication & Security](#2-authentication--security)
3. [Multi-User Architecture](#3-multi-user-architecture)
4. [Caching](#4-caching)
5. [Billing & Subscriptions](#5-billing--subscriptions)
6. [Web UI](#6-web-ui)
7. [REST API](#7-rest-api)
8. [User Preferences & Classification](#8-user-preferences--classification)
9. [Deployment & Configuration](#9-deployment--configuration)

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

### 1.3 Unified Provider Interface

All providers expose an identical method surface:

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
- Full CRUD is available on all providers through a single consistent API surface

---

## 2. Authentication & Security

### Registration with Email Verification

New accounts are not active until the user verifies their email address.

| Step | Detail |
|---|---|
| Registration | `POST /auth/register` creates the account with `email_verified = false`; no JWT is issued yet |
| Verification email | Server generates a 64-character random hex token, stores it with a 24-hour expiry, and emails a verification link |
| Email fallback | If `SMTP_HOST` is not configured, the verify URL is logged to the server console (useful for local development) |
| Verify link | `GET /auth/verify-email?token=…` validates the token, sets `email_verified = true`, issues a JWT, and redirects to `/pricing.html#token=<jwt>` |
| JWT delivery | JWT is passed in the URL fragment (`#token=…`) so it is never transmitted to any server in request headers or logs |
| Resend | `POST /auth/resend-verification` generates a fresh token and resends the email; no authentication required since the user cannot log in yet |
| Login gate | `POST /auth/login` returns `403 { code: "EMAIL_NOT_VERIFIED" }` if the account exists but is not verified |

**Benefits:**
- Confirms the user owns the email address before granting access — critical for subscription billing
- Unverified accounts cannot log in, preventing ghost accounts from accumulating
- 24-hour token expiry limits the window for stale or stolen links
- URL fragment delivery means the JWT is never written to server access logs or sent as a query parameter to third-party services

### Password Reset

Users who have forgotten their password can request a reset link by email.

| Step | Detail |
|---|---|
| Request | `POST /auth/forgot-password` accepts `{ email }`; always returns the same generic message (no email-existence leak) |
| Reset token | Server generates a 64-character random hex token, stores it with a **1-hour expiry** |
| Email | Link sent to `reset-password.html?token=…`; if SMTP not configured, URL is logged to console |
| Reset form | User enters and confirms new password; submitted to `POST /auth/reset-password` |
| Password update | Token validated, password hashed with bcrypt, token columns cleared |

**Benefits:**
- Generic response to `/auth/forgot-password` prevents account enumeration (attackers cannot tell whether an email is registered)
- 1-hour token expiry tightly limits the window for stolen reset links
- Token is single-use and cleared immediately on successful reset

### JWT Authentication

Tokens are signed with HS256 and expire after **30 days**.

| Endpoint | Auth | Description |
|---|---|---|
| `POST /auth/register` | No | Create account; sends verification email — no token returned until verified |
| `POST /auth/login` | No | Authenticate; returns a 30-day JWT (requires verified email) |
| `GET /auth/verify-email` | No | Verify token from email link; issues JWT and redirects to pricing |
| `POST /auth/resend-verification` | No | Resend the verification email by username |
| `POST /auth/forgot-password` | No | Request a password-reset email by email address |
| `POST /auth/reset-password` | No | Set a new password using a valid reset token |
| `POST /auth/refresh` | Yes | Issue a new 30-day token from a valid existing token |
| `GET /auth/me` | Yes | Return the current user's profile |

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
| `users` | One row per registered user — credentials, preferences, default provider, Stripe info, email verification state |
| `user_credentials` | One row per user per connected OAuth provider — encrypted tokens |

**`users` columns:**

| Column | Type | Description |
|---|---|---|
| `user_id` | TEXT PK | Unique user identifier (timestamp + random suffix) |
| `username` | TEXT UNIQUE | Login name |
| `email` | TEXT | Email address (required; used for Stripe and verification) |
| `password_hash` | TEXT | bcrypt hash |
| `created_at` | TIMESTAMPTZ | Account creation timestamp |
| `default_provider` | TEXT | Active provider fallback |
| `show_completed` | BOOLEAN | Whether completed tasks appear in counts |
| `classification_rules` | JSONB | Per-user task classification overrides (null = use server defaults) |
| `stripe_customer_id` | TEXT | Stripe customer ID (set after first checkout) |
| `subscription_status` | TEXT | `none`, `active`, `trialing`, `canceled` |
| `email_verified` | BOOLEAN | Whether the email address has been confirmed |
| `verification_token` | TEXT | Pending verification token (cleared after use) |
| `verification_token_expires` | TIMESTAMPTZ | Token expiry (24 hours from generation) |

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
| `user:id:{userId}` | JSON user object | `updateDefaultProvider`, `updatePreferences`, email verification, subscription update |
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
| Tasks (`tasks:{userId}:{provider}:{listId}`) | 30 seconds | Task create, update, complete, delete, **classification rule change** |
| Unified tasks (`unified:{userId}`) | 30 seconds | Task create, update, complete, delete, **classification rule change** |

**Benefits:**
- Dramatically reduces calls to external task APIs (Microsoft Graph, Google Tasks API) for frequently-visited data
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

## 5. Billing & Subscriptions

Subscription management is handled by **Stripe Checkout**. No payment card data ever touches the server.

### Plans

| Plan | Price | Detail |
|---|---|---|
| Monthly | $8 / month | Cancel anytime — uses `STRIPE_PRICE_ID_MONTHLY` |
| Annual | $85 / year | ~$7.08/month; saves $11/year — uses `STRIPE_PRICE_ID_ANNUAL` |
| Free Trial | $0 for N days | Configurable via `STRIPE_TRIAL_DAYS` (default 14); monthly price applies after trial |

### Checkout Flow

1. User selects a plan on `/pricing.html` and clicks Subscribe
2. Server creates a Stripe Checkout session with the selected price (and `trial_period_days` for the trial plan)
3. User is redirected to Stripe's hosted checkout page to enter payment details
4. On success, Stripe redirects back to `/success.html?session_id=…`
5. The success page calls `/billing/session-info` to display the confirmed plan and renewal/trial-end date
6. User clicks **Continue** — the page checks provider status and routes to Settings (if no providers connected) or Lists

### Webhook

Stripe sends signed events to `POST /billing/webhook`. The server verifies the signature using `STRIPE_WEBHOOK_SECRET` before processing.

| Event | Action |
|---|---|
| `checkout.session.completed` | Sets `subscription_status = 'active'` and stores `stripe_customer_id` |
| `customer.subscription.deleted` | Sets `subscription_status = 'canceled'` |

**Benefits:**
- Stripe handles all PCI-DSS compliance for card data — the server never sees raw card numbers
- Webhook signature verification prevents spoofed events from activating accounts
- The `already subscribed` check on `/pricing.html` skips the page entirely for users who are already active
- Session info is fetched directly from Stripe on the success page — no dependency on the webhook having fired yet

---

## 6. Web UI

A browser-based interface served as static files from `src/public/` directly by the Express server. No separate web server or build step required.

### Sign In / Register (`/`)

- Login and registration on a single page with a toggle link between forms
- Registration collects username, password, and email (all required)
- After registration: hides the form and shows a "Check your email" confirmation panel with the registered address; includes a "Resend the email" link
- After login with unverified account: shows a yellow notice with a "Resend verification email" link instead of a generic error
- Auto-redirects to the lists view if a valid token is already in `localStorage`
- Proper `autocomplete` attributes on all form inputs for browser password manager compatibility

### Pricing / Subscribe (`/pricing.html`)

- Displays three subscription plans (Monthly, Annual, Free Trial) as selectable cards
- Annual plan is selected by default and marked "Best Value"
- Subscribe button label changes to "Start Free Trial" when the trial plan is selected; a credit-card-required notice appears
- Skips directly to `/lists.html` if the user already has an active subscription
- Receives the JWT from the email verification redirect via URL fragment (`#token=…`); stores it in `localStorage` and clears the fragment before proceeding

### Subscription Confirmed (`/success.html`)

- Displayed after Stripe Checkout completes
- Fetches session details from `/billing/session-info` and shows the confirmed plan name, renewal date (or trial-end date), and a truncated reference ID
- **Continue** button: calls `/auth/providers/status` and routes to `/settings.html` if no providers are connected, or `/lists.html` if at least one is

### Lists View (`/lists.html`)

- Displays all task lists for all connected providers
- Provider filter tabs (All / Microsoft / Google) persist selection in `localStorage`
- Shows task count per list (loaded asynchronously after the list renders)
- Redirects to `/settings.html?reconnect=true` if no providers are connected

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

- Displays live connection status for each provider (Connected ✓ / Connect button)
- Set default provider per connected service
- Toggle the `showCompleted` preference
- Edit, export, and import per-user task classification rules (TOML format)
- Redirected to automatically after a successful OAuth callback (`?connected=microsoft` or `?connected=google`)
- Shows a reconnect banner when arriving from `/lists.html` with `?reconnect=true`

### Legal Pages

- `GET /privacy` — Privacy policy, served from `src/public/privacy.html`
- `GET /terms` — Terms of service, served from `src/public/terms.html`

**Benefits:**
- Clean `/privacy` and `/terms` URLs (not `/privacy.html`) satisfy OAuth app registration requirements for Google and Microsoft
- No build tool, bundler, or framework — the UI is plain HTML/CSS/JS and works immediately without a build step
- Static files served by the same Express process — no separate web server to configure or proxy

---

## 7. REST API

### Authentication Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | No | Create account (username, password, email required); sends verification email |
| `POST` | `/auth/login` | No | Authenticate; returns 30-day JWT. Returns `403 { code: "EMAIL_NOT_VERIFIED" }` if unverified |
| `GET` | `/auth/verify-email?token=…` | No | Verify email token; issues JWT and redirects to `/pricing.html#token=<jwt>` |
| `POST` | `/auth/resend-verification` | No | Resend verification email by `{ username }` |
| `POST` | `/auth/forgot-password` | No | Request a password-reset email by `{ email }`; always returns generic message |
| `POST` | `/auth/reset-password` | No | Set a new password with `{ token, newPassword }` |
| `POST` | `/auth/refresh` | Yes | Issue a new 30-day token from a valid existing token |
| `GET` | `/auth/me` | Yes | Return the current user's profile |
| `GET` | `/auth/providers/status` | Yes | Live connection check for all providers |
| `GET` | `/auth/microsoft/url` | Yes | Generate a Microsoft OAuth authorization URL |
| `GET` | `/auth/microsoft/callback` | — | Microsoft OAuth callback; stores tokens and redirects to `/settings.html?connected=microsoft` |
| `POST` | `/auth/microsoft/token` | Yes | Store a Microsoft access token manually (fallback) |
| `GET` | `/auth/google/url` | Yes | Generate a Google OAuth authorization URL |
| `GET` | `/auth/google/callback` | — | Google OAuth callback; stores tokens and redirects to `/settings.html?connected=google` |
| `DELETE` | `/auth/provider/:provider` | Yes | Disconnect a provider and remove its stored credentials |
| `PATCH` | `/auth/default-provider` | Yes | Update the user's default provider |
| `PATCH` | `/auth/preferences` | Yes | Update user preferences (`showCompleted`) |

### Classification Rule Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/auth/me/classification` | Yes | Return effective rules (user's custom or server defaults) and whether they are custom |
| `PUT` | `/auth/me/classification` | Yes | Save custom classification rules; flushes all task caches for this user |
| `DELETE` | `/auth/me/classification` | Yes | Reset to server defaults; flushes all task caches for this user |
| `POST` | `/auth/me/classification/parse` | Yes | Parse a TOML classification file and return validated rules without saving |

### Billing Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/billing/status` | Yes | Return the user's `subscriptionStatus` (`none`, `active`, `trialing`, `canceled`) |
| `POST` | `/billing/create-checkout-session` | Yes | Create a Stripe Checkout session for the selected `plan` (`monthly`, `annual`, `trial`); returns `{ url }` |
| `GET` | `/billing/session-info?session_id=…` | Yes | Fetch plan type, status, trial end, and billing period end for a completed checkout session |
| `POST` | `/billing/webhook` | — (Stripe signature) | Receive Stripe events; requires raw body and `STRIPE_WEBHOOK_SECRET` |

### Task Endpoints

All task endpoints require a `Bearer` token. The provider is selected by `?provider=` query parameter, falling back to the user's `defaultProvider`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tasks/unified` | All tasks from all connected providers across all lists |
| `GET` | `/api/lists` | All task lists for the active provider |
| `GET` | `/api/lists/counts` | Task counts for all lists in a single call |
| `GET` | `/api/lists/:listId/tasks` | All tasks in a list |
| `GET` | `/api/lists/:listId/tasks/:taskId` | Single task detail |
| `POST` | `/api/lists/:listId/tasks` | Create a new task |
| `PATCH` | `/api/lists/:listId/tasks/:taskId` | Update a task (name, notes, due date) |
| `PATCH` | `/api/lists/:listId/tasks/:taskId/complete` | Mark a task as complete |
| `DELETE` | `/api/lists/:listId/tasks/:taskId` | Delete a task permanently |

All three GET task endpoints (`/api/tasks/unified`, `/api/lists/:listId/tasks`, `/api/lists/:listId/tasks/:taskId`) include a `classification` field on every task object:

```json
{ "classification": "now" | "not_now" | "later" | null }
```

`null` is returned for completed tasks. The classification is computed server-side using the requesting user's effective rules (custom rules if set, otherwise server defaults). Clients do not need to implement any classification logic.

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

## 8. User Preferences & Classification

### Default Provider

Each user has a `defaultProvider` field (`microsoft` or `google`). Used as the fallback when `?provider=` is not specified in a request.

**Benefits:**
- Clients that don't specify a provider always get a meaningful response without error
- Can be changed at any time via `PATCH /auth/default-provider`

### Show Completed

The `showCompleted` boolean preference controls whether completed tasks are included in the counts returned by `/api/lists/counts`. Default is `false`.

**Benefits:**
- Users who want a clean count of remaining work see only incomplete tasks
- Users who want a full picture can opt in
- Preference is stored per user in PostgreSQL and respected server-side — clients need no filtering logic

### Task Classification Rules

Tasks are classified into three buckets — **Now**, **Not Now**, and **Later** — based on configurable rules. Classification is computed **server-side** and returned as a `classification` field on every task object from the three GET task endpoints.

| Bucket | Default criteria |
|---|---|
| Now | Overdue tasks; high-priority tasks |
| Not Now | Tasks with future due dates; normal-priority tasks |
| Later | Everything else (catch-all) |

Rules are evaluated in order (`now` → `not_now` → `later`). Conditions within a bucket are OR'd. Completed tasks always receive `classification: null`.

Rules are defined server-wide in `config/classification.toml` and can be overridden per user.

| Operation | Endpoint |
|---|---|
| View effective rules | `GET /auth/me/classification` — returns custom rules if set, otherwise server defaults; includes `isCustom` flag |
| Save custom rules | `PUT /auth/me/classification` — body: `{ now, not_now, later }`; flushes task caches |
| Reset to defaults | `DELETE /auth/me/classification` — flushes task caches |
| Validate a TOML file | `POST /auth/me/classification/parse` — parses and validates without saving |
| Export rules | Settings UI → Export (downloads a `.toml` file) |
| Import rules | Settings UI → Import (upload a `.toml` file; shows a preview before applying) |

**Benefits:**
- Classification is applied once on the server — clients read `task.classification` directly and need no classification logic of their own
- Any client (web UI, mobile app, third-party integration) automatically receives pre-classified tasks without reimplementing the rules
- Changing classification rules immediately flushes task caches, so the next request reflects the new rules
- Server-wide defaults apply to all users without any configuration, so the feature works out of the box
- Per-user overrides are stored as JSONB in PostgreSQL — no extra table required
- TOML import/export lets power users manage rules in a text editor and share them across accounts
- The parse-only endpoint validates structure before saving, preventing bad rules from being stored

---

## 9. Deployment & Configuration

### Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` / `API_PORT` | No | `3500` | Task API server port |
| `WEB_PORT` | No | `80` | Web server HTTP port |
| `HTTPS_PORT` | No | `443` | Web server HTTPS port (requires SSL_KEY_PATH + SSL_CERT_PATH) |
| `WEB_URL` | Yes (prod) | `http://localhost` | Public base URL — used in OAuth redirects, verification emails, Stripe success URL |
| `JWT_SECRET` | Yes | — | HS256 signing key for JWTs |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | No | — | Redis connection string; enables shared cache |
| `ENCRYPTION_KEY` | Yes | — | 64-char hex key for AES-256-GCM token encryption |
| `STRIPE_SECRET_KEY` | No | — | Stripe API key; billing disabled if absent |
| `STRIPE_WEBHOOK_SECRET` | No | — | Stripe webhook signing secret |
| `STRIPE_PRICE_ID_MONTHLY` | No | falls back to `STRIPE_PRICE_ID` | Monthly plan price ID |
| `STRIPE_PRICE_ID_ANNUAL` | No | — | Annual plan price ID |
| `STRIPE_TRIAL_DAYS` | No | `14` | Free trial length in days |
| `SMTP_HOST` | No | — | SMTP server; if absent, verify URLs are logged to console |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_SECURE` | No | `false` | `true` for port 465 implicit TLS |
| `SMTP_USER` | No | — | SMTP login username |
| `SMTP_PASSWORD` | No | — | SMTP login password |
| `SMTP_FROM` | No | `handsbreadth LLC <noreply@handsbreadth.com>` | From address on outgoing emails |
| `MICROSOFT_CLIENT_ID` | No | — | Azure app registration client ID |
| `MICROSOFT_CLIENT_SECRET` | No | — | Azure app registration client secret |
| `MICROSOFT_TENANT_ID` | No | `common` | `common` for any account; specific tenant ID to restrict |
| `MICROSOFT_REDIRECT_URI` | No | — | Must match Azure app registration |
| `GOOGLE_CLIENT_ID` | No | — | Google Cloud OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | — | Google Cloud OAuth client secret |
| `GOOGLE_REDIRECT_URI` | No | — | Must match Google Cloud Console |
| `DEFAULT_PROVIDER` | No | `microsoft` | Default provider for new users |

### Auto Schema Migration

On startup, the server runs the full `schema.sql` using `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. New columns added to the schema are applied automatically on next boot.

**Benefits:**
- No migration tooling required
- Safe to run on an existing database — existing tables and data are not affected
- Deploying a new version is a simple `git pull && npm start`

### HTTPS Support

The web server supports HTTPS when `SSL_KEY_PATH` and `SSL_CERT_PATH` are set. An automatic HTTP → HTTPS redirect runs on `WEB_PORT`.

### CORS

`cors()` middleware is applied globally. The allowed origin can be restricted with `ALLOWED_ORIGIN`.

**Benefits:**
- Web UIs served from a different origin can call the API without browser CORS errors
- Supports integration with mobile webviews and third-party clients

### Development Scripts

| Script | Command | Purpose |
|---|---|---|
| Start all | `npm run start:all` | Start API + web server (PostgreSQL and Redis must be running) |
| Start API | `npm run start:api` | Start task API server only |
| Start web | `npm run start:web` | Start web server only |
| Create admin | `npm run create-admin` | Create or reset the built-in admin account (pre-verified, always active, no Stripe required) |
| Delete test user | `npm run delete-test-user` | Delete all accounts with `johnsonalan006@gmail.com` from PostgreSQL and Redis |
| Get verify URL | `npm run get-verify-url [username\|email]` | Print the pending verification URL from the database (for local testing without SMTP) |
