# Unified Task Server

A multi-user REST API server that integrates with Apple Reminders, Microsoft Tasks, and Google Tasks, providing a unified interface for task management across all three platforms.

## Features

- **Apple Reminders** — Via WebSocket bridge to a local [hb-task-server](https://github.com/handsbreadth/hb-task-server) instance; no inbound firewall changes required
- **Microsoft Tasks** — Microsoft Graph API with per-user OAuth
- **Google Tasks** — Google Tasks API with per-user OAuth
- **Multi-user** — JWT authentication with complete per-user data isolation
- **Web UI** — Built-in browser dashboard for managing lists, tasks (create, edit, complete, delete), and provider connections
- **PostgreSQL** — Persistent storage with encrypted OAuth token storage (AES-256-GCM)
- **Redis** — Optional shared cache for multi-instance deployments (falls back to Postgres if not configured)
- **In-memory cache** — Per-server TTL cache (provider status: 5 min, lists: 2 min, task counts: 2 min, tasks: 30 sec)

## Prerequisites

- Node.js v14 or later
- PostgreSQL 18 (macOS: `brew install postgresql@18`)
- Redis (optional — macOS: `brew install redis`) — required only for multi-instance deployments
- macOS (required for Apple Reminders integration)
- Microsoft Azure account (for Microsoft Tasks)
- Google Cloud account (for Google Tasks)

---

## Installation

### 1. Install dependencies

```bash
npm install
```

### 2. Create the database

Start PostgreSQL (macOS/Homebrew):

```bash
./startdb.sh
```

Create the application database (run once):

```bash
/opt/homebrew/opt/postgresql@18/bin/createdb hb_task_server
```

> **Note:** On macOS with Homebrew, the default PostgreSQL superuser is your OS username — there is no `postgres` role by default.

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and set the required values:

```bash
# Replace <your-os-username> with the output of: whoami
DATABASE_URL=postgres://<your-os-username>@localhost:5432/hb_task_server

# Generate a 64-character hex key:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=<generated-hex-key>

JWT_SECRET=<long-random-string>

# Default task provider shown in the web UI (microsoft, google, or apple)
DEFAULT_PROVIDER=microsoft

# Optional: enable Redis for multi-instance deployments
# REDIS_URL=redis://localhost:6379
```

### 4. Start the server

```bash
npm start
```

On first boot the server applies the database schema automatically. You should see:

```
User service initialized
UserService: connected to PostgreSQL
🚀 Multi-User Task Server running on http://localhost:3500
```

Open `http://localhost:3500` in a browser to access the web dashboard.

For development with auto-reload:

```bash
npm run dev
```

---

## Testing the Server

### Health check

```bash
curl http://localhost:3500/health
```

### Register a user

```bash
curl -s -X POST http://localhost:3500/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123","email":"alice@example.com"}' | jq .
```

Response:

```json
{
  "message": "User registered successfully",
  "user": {
    "userId": "...",
    "username": "alice",
    "email": "alice@example.com",
    "createdAt": "2026-03-03T..."
  },
  "token": "<jwt-token>"
}
```

### Log in

```bash
curl -s -X POST http://localhost:3500/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}' | jq .
```

Copy the `token` from the response for use in subsequent requests.

### Verify the token (confirm login)

```bash
curl -s http://localhost:3500/auth/me \
  -H "Authorization: Bearer <token>" | jq .
```

### Confirm data in the database

```bash
/opt/homebrew/opt/postgresql@18/bin/psql hb_task_server \
  -c "SELECT user_id, username, default_provider, created_at FROM users;"
```

### Stop the server

Press `Ctrl+C` in the terminal running `npm start`.

> **Logout** is client-side only — there is no `/auth/logout` endpoint. JWT tokens are stateless; logout means discarding the token on the client.

---

## Configuration

### Provider setup

#### Apple Reminders (via bridge)

Apple Reminders is accessed through a persistent WebSocket bridge to the user's local [hb-task-server](https://github.com/handsbreadth/hb-task-server). The local server runs on the user's Mac and initiates the outbound connection — no inbound ports or firewall changes are needed.

**No server-side configuration is required.** Each user sets up their own bridge independently:

1. The user calls `POST /auth/bridge/key` (authenticated) to generate a personal API key.
2. They add the key and this server's WebSocket URL to their local `hb-task-server` `.env`:
   ```
   BRIDGE_URL=wss://your-upq-domain.com/bridge
   BRIDGE_API_KEY=<key>
   ```
3. They restart `hb-task-server` — it connects automatically.
4. The user sets their default provider to `apple` in UpQ settings.

See [PROVIDERS.md](PROVIDERS.md) for the full bridge protocol description.

#### Microsoft Tasks

1. Register an app in [Azure Portal](https://portal.azure.com) > **Microsoft Entra ID** > **Manage** > **App registrations** (Azure Active Directory was renamed to Microsoft Entra ID in 2023)
2. Add delegated permissions under **Manage > API permissions**: `Tasks.ReadWrite`, `offline_access`, `User.Read` (Microsoft Graph)
3. Create a client secret under **Manage > Certificates & secrets > New client secret** — copy the **Value** (not the Secret ID) immediately
4. Register the redirect URI under **Manage > Authentication > Add a platform > Web**:
   ```
   http://localhost:3500/auth/microsoft/callback
   ```
5. Add to `.env`:
   ```
   MICROSOFT_CLIENT_ID=<application-id>
   MICROSOFT_CLIENT_SECRET=<client-secret-value>
   MICROSOFT_TENANT_ID=<tenant-id>
   MICROSOFT_REDIRECT_URI=http://localhost:3500/auth/microsoft/callback
   ```

**Connecting a user to Microsoft Tasks:**

Each user connects their own Microsoft account independently. The flow uses standard OAuth 2.0 — Microsoft shows a consent screen listing exactly what the app will access.

```bash
# 1. Get the OAuth authorization URL (requires a logged-in user's JWT token)
curl -s http://localhost:3500/auth/microsoft/url \
  -H "Authorization: Bearer <jwt-token>" | jq .authUrl

# 2. Open the returned URL in a browser
#    - Sign in with your Microsoft account
#    - Microsoft displays a consent prompt listing the requested permissions:
#        • Read and write your tasks (Tasks.ReadWrite)
#        • Maintain access to data you have given it access to (offline_access)
#        • Sign you in and read your profile (User.Read)
#    - Click Accept — Microsoft redirects to /auth/microsoft/callback automatically
#    - You will see: { "success": true, "message": "Microsoft Tasks connected successfully" }

# 3. The server stores the tokens — the user can now access Microsoft Tasks
curl -s "http://localhost:3500/api/lists?provider=microsoft" \
  -H "Authorization: Bearer <jwt-token>" | jq .
```

> Each user grants consent for their own account only. No admin approval is required.

#### Google Tasks

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable the Google Tasks API
3. Create OAuth 2.0 credentials (Web application)
4. Set redirect URI: `http://localhost:3500/auth/google/callback`
5. Add to `.env`:
   ```
   GOOGLE_CLIENT_ID=<client-id>
   GOOGLE_CLIENT_SECRET=<client-secret>
   GOOGLE_REDIRECT_URI=http://localhost:3500/auth/google/callback
   ```

---

## API Reference

All protected endpoints require a JWT Bearer token:

```
Authorization: Bearer <token>
```

Obtain a token from `POST /auth/register` or `POST /auth/login`.

### Token lifetime and refresh

Tokens are valid for **30 days**. When a token expires the server returns `401 Unauthorized`.

#### Web clients (browser)
The dashboard detects a `401` and redirects to the login page automatically. The user logs in and a new 30-day token is issued.

#### API clients (mobile apps, smartwatches, integrations)

**Proactive refresh (recommended):** Before a token expires, exchange it for a new one without user interaction:

```http
POST /auth/refresh
Authorization: Bearer <current-token>
```

Response:
```json
{ "token": "<new-30-day-token>" }
```

Store the new token and discard the old one. A good strategy is to call `/auth/refresh` on every app launch if the stored token is older than 15 days — this ensures active users never see an expiry prompt.

**Reactive re-login:** If a request returns `401` (token expired or missing), prompt the user to log in again:

```http
POST /auth/login
Content-Type: application/json

{ "username": "<username>", "password": "<password>" }
```

Store the returned `token` securely (iOS Keychain, Android Keystore, or the watch's equivalent secure storage). Never store credentials in plain text or in unprotected app storage.

**Recommended token management flow for API clients:**

```
App launch
  └─ Load stored token
      ├─ No token → show login screen
      └─ Token exists
          ├─ Token age > 15 days → POST /auth/refresh → store new token
          └─ Make API requests
              └─ Response 401 → token expired → show login screen
```

### Auth endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | No | Register a new user |
| `POST` | `/auth/login` | No | Log in, receive a token |
| `POST` | `/auth/refresh` | Yes | Issue a new token from a valid existing token |
| `GET` | `/auth/me` | Yes | Get current user info |
| `GET` | `/auth/providers/status` | Yes | Live connection check for all providers (cached 5 min) |
| `GET` | `/auth/microsoft/url` | Yes | Get Microsoft OAuth URL |
| `GET` | `/auth/microsoft/callback` | — | Microsoft OAuth callback |
| `POST` | `/auth/microsoft/token` | Yes | Store Microsoft token manually (fallback) |
| `GET` | `/auth/google/url` | Yes | Get Google OAuth URL |
| `GET` | `/auth/google/callback` | — | Google OAuth callback |
| `DELETE` | `/auth/provider/:provider` | Yes | Disconnect a provider |
| `PATCH` | `/auth/default-provider` | Yes | Set default provider (`microsoft`, `google`, or `apple`) |
| `PATCH` | `/auth/preferences` | Yes | Update user preferences |
| `POST` | `/auth/bridge/key` | Yes | Generate a bridge API key for hb-task-server |
| `DELETE` | `/auth/bridge/key` | Yes | Revoke bridge API key and disconnect active session |
| `GET` | `/auth/bridge/status` | Yes | Check bridge connection status (`{ hasKey, connected }`) |

#### `PATCH /auth/preferences`

Update per-user display preferences.

```json
{ "showCompleted": true }
```

Response:
```json
{ "success": true, "showCompleted": true }
```

When `showCompleted` is `false` (the default), completed tasks are excluded from task counts returned by `/api/lists/counts`.

### Task endpoints

All task endpoints require authentication. The provider is selected by the `?provider=` query parameter, falling back to the user's `defaultProvider`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/lists` | Get all task lists |
| `GET` | `/api/lists/counts` | Get task counts for all lists (single call) |
| `GET` | `/api/lists/:listId/tasks` | Get tasks in a list |
| `GET` | `/api/lists/:listId/tasks/:taskId` | Get task details |
| `POST` | `/api/lists/:listId/tasks` | Create a task |
| `PATCH` | `/api/lists/:listId/tasks/:taskId` | Update a task (name, notes, due date) |
| `PATCH` | `/api/lists/:listId/tasks/:taskId/complete` | Mark task complete |
| `DELETE` | `/api/lists/:listId/tasks/:taskId` | Delete a task |

#### `GET /api/lists/counts`

Returns the number of tasks per list in a single API call, respecting the user's `showCompleted` preference.

```bash
curl -s "http://localhost:3500/api/lists/counts?provider=microsoft" \
  -H "Authorization: Bearer <token>" | jq .
```

Response:
```json
{
  "provider": "microsoft",
  "counts": {
    "<listId-1>": 3,
    "<listId-2>": 12
  }
}
```

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/providers` | List available providers |
| `GET` | `/privacy` | Privacy policy page |
| `GET` | `/terms` | Terms of service page |

---

## Deployment Modes

The server supports two deployment modes controlled entirely by the presence of `REDIS_URL` in `.env`.

### Single-instance (no Redis)

```
Client → Express → UserService → PostgreSQL
```

All reads go directly to PostgreSQL. Suitable for a single server process. No additional infrastructure required beyond Postgres.

```bash
# .env — omit REDIS_URL or leave it commented out
DATABASE_URL=postgres://<user>@localhost:5432/hb_task_server
```

### Multi-instance (with Redis)

```
Client → [Instance 1]  ↘
                         Redis ← → PostgreSQL
Client → [Instance 2]  ↗
```

Redis acts as a shared read cache across all instances. Each read checks Redis first; on a cache miss the data is fetched from Postgres and stored in Redis for subsequent reads. All writes go to both Postgres (durable) and Redis (cache update/invalidation).

```bash
# .env — add REDIS_URL
DATABASE_URL=postgres://<user>@localhost:5432/hb_task_server
REDIS_URL=redis://localhost:6379
```

Start Redis (macOS/Homebrew):
```bash
redis-server
# or as a background service:
brew services start redis
```

### Cache behavior

| Operation | Without Redis | With Redis |
|-----------|--------------|------------|
| `getUser` | Postgres query | Redis hit (or Postgres + cache populate on miss) |
| `getCredentials` | Postgres query | Redis hit (or Postgres + cache populate on miss) |
| `authenticate` | Postgres query | Redis hit (or Postgres + cache populate on miss) |
| `register` | Postgres insert | Postgres insert + Redis set |
| `storeCredentials` | Postgres upsert | Postgres upsert + Redis set |
| `removeCredentials` | Postgres delete | Postgres delete + Redis delete |
| `updateDefaultProvider` | Postgres update | Postgres update + Redis invalidate |

**Redis key schema:**

| Key | Value |
|-----|-------|
| `user:id:{userId}` | JSON user object |
| `user:name:{username}` | JSON user object |
| `creds:{userId}:{provider}` | JSON credentials (tokens stored decrypted in Redis) |

> OAuth tokens are encrypted (AES-256-GCM) at rest in PostgreSQL. They are stored decrypted in Redis — ensure Redis is secured appropriately in production (auth, TLS, private network).

---

## Architecture

```
hb-task-server-enterprise/
├── src/
│   ├── server.js               # Express + HTTP server, all routes
│   ├── bridge-server.js        # WebSocket server: authenticates and manages bridge connections
│   ├── auth/
│   │   ├── authService.js      # JWT generation and middleware
│   │   └── userService.js      # User registration, auth, credential and bridge key storage
│   ├── db/
│   │   ├── db.js               # pg connection pool + AES-256-GCM encryption helpers
│   │   ├── cache.js            # ioredis wrapper (no-ops if REDIS_URL not set)
│   │   └── schema.sql          # Database schema (applied automatically on startup)
│   ├── providers/
│   │   ├── apple-bridge.js     # Apple Reminders — routes calls through WebSocket bridge
│   │   ├── microsoft.js        # Microsoft Graph API
│   │   └── google.js           # Google Tasks API
│   └── public/                 # Web UI (served as static files)
│       ├── index.html          # Login page
│       ├── settings.html       # Provider connections and preferences
│       ├── lists.html          # Task lists view
│       ├── tasks.html          # Tasks view
│       ├── privacy.html        # Privacy policy
│       └── terms.html          # Terms of service
├── startdb.sh                  # Start PostgreSQL (macOS/Homebrew)
├── .env.example
└── package.json
```

### Database schema

**`users`** — one row per registered user

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | TEXT | Primary key, generated by the app |
| `username` | TEXT | Unique |
| `email` | TEXT | Nullable |
| `password_hash` | TEXT | bcrypt, 10 rounds |
| `created_at` | TIMESTAMPTZ | |
| `default_provider` | TEXT | `apple`, `microsoft`, or `google` |
| `show_completed` | BOOLEAN | Default `false` — include completed tasks in counts |

**`user_credentials`** — OAuth tokens per user per provider

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | TEXT | FK → users, cascades on delete |
| `provider` | TEXT | Composite PK with user_id |
| `access_token` | TEXT | AES-256-GCM encrypted |
| `refresh_token` | TEXT | AES-256-GCM encrypted, nullable |
| `updated_at` | TIMESTAMPTZ | |

**`bridge_api_keys`** — One bridge API key per user for hb-task-server authentication

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | TEXT | PK and FK → users, cascades on delete |
| `key_hash` | TEXT | SHA-256 hash of the API key (raw key never stored) |
| `created_at` | TIMESTAMPTZ | |

---

## Troubleshooting

**`role "postgres" does not exist`**
Homebrew PostgreSQL uses your macOS username as the superuser. Set `DATABASE_URL` to `postgres://<your-os-username>@localhost:5432/hb_task_server`.

**`ENCRYPTION_KEY must be a 64-character hex string`**
Generate a valid key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Apple Reminders: "bridge is not connected"**
The user's `hb-task-server` is not running or has not connected. Ensure it is running with `BRIDGE_URL` and `BRIDGE_API_KEY` set in its `.env`. Check `GET /auth/bridge/status` to confirm.

**Apple Reminders: "Invalid API key" (bridge connection refused)**
The key in `hb-task-server`'s `.env` does not match the stored key. Regenerate with `POST /auth/bridge/key` and update the local `.env`.

**Microsoft: "Client not initialized"**
The user has not connected Microsoft Tasks yet. Complete the OAuth flow via `GET /auth/microsoft/url`.

**Microsoft: "Token exchange failed" or AADSTS errors**
- Ensure `MICROSOFT_REDIRECT_URI` in `.env` exactly matches the redirect URI registered in Azure Portal
- Ensure `Tasks.ReadWrite`, `offline_access`, and `User.Read` delegated permissions are added and granted
- The `MICROSOFT_CLIENT_SECRET` must be the **Value** field, not the Secret ID (GUIDs are Secret IDs, not values)

**Google: "Invalid grant"**
The OAuth authorization code expired. Repeat the flow from `GET /auth/google/url`.

**Redis: `connect ECONNREFUSED 127.0.0.1:6379`**
Redis is configured but not running. Either start it (`redis-server`) or remove `REDIS_URL` from `.env` to run without it.

**Redis: stale data after manual Postgres edits**
If you modify the `users` or `user_credentials` tables directly (e.g. via `psql`), flush the Redis cache: `redis-cli FLUSHDB`. The cache will repopulate from Postgres on next access.

---

## License

MIT
