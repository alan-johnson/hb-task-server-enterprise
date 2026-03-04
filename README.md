# Unified Task Server

A multi-user REST API server that integrates with Apple Reminders, Microsoft Tasks, and Google Tasks, providing a unified interface for task management across all three platforms.

## Features

- **Apple Reminders** — Native macOS integration via AppleScript
- **Microsoft Tasks** — Microsoft Graph API
- **Google Tasks** — Google Tasks API
- **Multi-user** — JWT authentication with complete per-user data isolation
- **PostgreSQL** — Persistent storage with encrypted OAuth token storage (AES-256-GCM)
- **Redis** — Optional shared cache for multi-instance deployments (falls back to Postgres if not configured)

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

# Optional: enable Redis for multi-instance deployments
# REDIS_URL=redis://localhost:6379
```

### 4. Start the server

```bash
npm start
```

On first boot the server applies the database schema automatically. You should see:

```
UserService: connected to PostgreSQL
Server running on port 3500
```

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

#### Apple Reminders

No configuration needed. Works automatically on macOS via AppleScript.

The first time you run the server, macOS may prompt you to grant Terminal access to Reminders. Click OK.

#### Microsoft Tasks

1. Register an app in [Azure Portal](https://portal.azure.com) > **Microsoft Entra ID** > **Manage** > **App registrations** (Azure Active Directory was renamed to Microsoft Entra ID in 2023)
2. Add delegated permission: `Tasks.ReadWrite` (Microsoft Graph)
3. Create a client secret
4. Set redirect URI: `http://localhost:3500/auth/microsoft/callback`
5. Add to `.env`:
   ```
   MICROSOFT_CLIENT_ID=<application-id>
   MICROSOFT_CLIENT_SECRET=<client-secret>
   MICROSOFT_TENANT_ID=<tenant-id>
   MICROSOFT_REDIRECT_URI=http://localhost:3500/auth/microsoft/callback
   ```

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

### Auth endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | No | Register a new user |
| `POST` | `/auth/login` | No | Log in, receive a token |
| `GET` | `/auth/me` | Yes | Get current user info |
| `GET` | `/auth/google/url` | Yes | Get Google OAuth URL |
| `GET` | `/auth/google/callback` | — | Google OAuth callback |
| `POST` | `/auth/microsoft/token` | Yes | Store Microsoft access token |
| `DELETE` | `/auth/provider/:provider` | Yes | Disconnect a provider |
| `PATCH` | `/auth/default-provider` | Yes | Set default provider |

### Task endpoints

All task endpoints require authentication. The provider used is determined by the authenticated user's `defaultProvider` setting (or their connected credentials).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/lists` | Get all task lists |
| `GET` | `/api/lists/:listId/tasks` | Get tasks in a list |
| `GET` | `/api/lists/:listId/tasks/:taskId` | Get task details |
| `POST` | `/api/lists/:listId/tasks` | Create a task |
| `PATCH` | `/api/lists/:listId/tasks/:taskId/complete` | Mark task complete |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/providers` | List available providers |

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
│   ├── server.js               # Express server and all routes
│   ├── auth/
│   │   ├── authService.js      # JWT generation and middleware
│   │   └── userService.js      # User registration, auth, credential storage
│   ├── db/
│   │   ├── db.js               # pg connection pool + AES-256-GCM encryption helpers
│   │   ├── cache.js            # ioredis wrapper (no-ops if REDIS_URL not set)
│   │   └── schema.sql          # Database schema (applied automatically on startup)
│   └── providers/
│       ├── apple.js            # Apple Reminders via AppleScript
│       ├── microsoft.js        # Microsoft Graph API
│       └── google.js           # Google Tasks API
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

**`user_credentials`** — OAuth tokens per user per provider

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | TEXT | FK → users, cascades on delete |
| `provider` | TEXT | Composite PK with user_id |
| `access_token` | TEXT | AES-256-GCM encrypted |
| `refresh_token` | TEXT | AES-256-GCM encrypted, nullable |
| `updated_at` | TIMESTAMPTZ | |

---

## Troubleshooting

**`role "postgres" does not exist`**
Homebrew PostgreSQL uses your macOS username as the superuser. Set `DATABASE_URL` to `postgres://<your-os-username>@localhost:5432/hb_task_server`.

**`ENCRYPTION_KEY must be a 64-character hex string`**
Generate a valid key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Apple Reminders: "Not authorized"**
Go to System Settings > Privacy & Security > Automation and grant Terminal access to Reminders.

**Microsoft: "Client not initialized"**
The user needs a stored access token. Call `POST /auth/microsoft/token` first.

**Google: "Invalid grant"**
The OAuth authorization code expired. Repeat the flow from `GET /auth/google/url`.

**Redis: `connect ECONNREFUSED 127.0.0.1:6379`**
Redis is configured but not running. Either start it (`redis-server`) or remove `REDIS_URL` from `.env` to run without it.

**Redis: stale data after manual Postgres edits**
If you modify the `users` or `user_credentials` tables directly (e.g. via `psql`), flush the Redis cache: `redis-cli FLUSHDB`. The cache will repopulate from Postgres on next access.

---

## License

MIT
