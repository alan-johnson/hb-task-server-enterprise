# Multi-User Mode Guide

This guide explains how to run the task server in multi-user mode with authentication and user isolation.

## Overview

In multi-user mode:
- Each user has their own account with username and password
- Users can only access their own tasks (complete isolation)
- JWT-based authentication (30-day tokens)
- Each user can connect their own Microsoft and Google accounts via OAuth
- Apple Reminders is available locally on macOS (opt-in)
- OAuth tokens are encrypted at rest (AES-256-GCM) in PostgreSQL

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with at minimum:

```bash
DATABASE_URL=postgres://<your-os-username>@localhost:5432/hb_task_server
JWT_SECRET=<long-random-string>
ENCRYPTION_KEY=<64-character-hex-string>
```

Generate the encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Start the server

```bash
npm start
```

The server runs on port `3500` by default. The database schema is applied automatically on first boot.

---

## User Registration & Authentication

### Register a new user

```bash
curl -s -X POST http://localhost:3500/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secure-password", "email": "alice@example.com"}' | jq .
```

Response:
```json
{
  "message": "User registered successfully",
  "user": {
    "userId": "1707139200000abc123",
    "username": "alice",
    "email": "alice@example.com",
    "createdAt": "2026-02-05T10:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

Save the token — you'll need it for all authenticated requests. Tokens are valid for **30 days**.

### Log in

```bash
curl -s -X POST http://localhost:3500/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secure-password"}' | jq .
```

### Refresh a token (before it expires)

```bash
curl -s -X POST http://localhost:3500/auth/refresh \
  -H "Authorization: Bearer <current-token>" | jq .
```

Returns a new 30-day token. The old token remains valid until its own expiry.

### Get current user info

```bash
curl -s http://localhost:3500/auth/me \
  -H "Authorization: Bearer <token>" | jq .
```

---

## Using the Task API

All task endpoints require the `Authorization: Bearer <token>` header. The `?provider=` query parameter selects which task service to use.

### Lists

```bash
# Get all lists
curl -s "http://localhost:3500/api/lists?provider=microsoft" \
  -H "Authorization: Bearer <token>" | jq .

# Get task counts for all lists (single call)
curl -s "http://localhost:3500/api/lists/counts?provider=microsoft" \
  -H "Authorization: Bearer <token>" | jq .
```

### Tasks — full CRUD

```bash
# Get all tasks in a list
curl -s "http://localhost:3500/api/lists/<listId>/tasks?provider=microsoft" \
  -H "Authorization: Bearer <token>" | jq .

# Create a task
curl -s -X POST "http://localhost:3500/api/lists/<listId>/tasks?provider=microsoft" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Buy groceries", "notes": "Milk, eggs, bread", "dueDate": "2026-03-10"}' | jq .

# Update a task (partial — only send fields you want to change)
curl -s -X PATCH "http://localhost:3500/api/lists/<listId>/tasks/<taskId>?provider=microsoft" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Buy groceries and coffee", "dueDate": "2026-03-11"}' | jq .

# Mark a task complete
curl -s -X PATCH "http://localhost:3500/api/lists/<listId>/tasks/<taskId>/complete?provider=microsoft" \
  -H "Authorization: Bearer <token>" | jq .

# Delete a task
curl -s -X DELETE "http://localhost:3500/api/lists/<listId>/tasks/<taskId>?provider=microsoft" \
  -H "Authorization: Bearer <token>" | jq .
```

---

## Provider Configuration (Per User)

Each user connects their own provider accounts independently.

### Apple Reminders

Apple Reminders works on macOS only and must be explicitly enabled:

```bash
# .env
ENABLE_APPLE_PROVIDER=true
```

No OAuth required — the server accesses the Reminders app of the macOS user account running the server process.

### Microsoft Tasks (per user)

```bash
# 1. Get the OAuth authorization URL
curl -s http://localhost:3500/auth/microsoft/url \
  -H "Authorization: Bearer <token>" | jq .authUrl

# 2. Open the URL in a browser, sign in, and accept the permissions prompt.
#    The server stores the tokens automatically after the redirect.

# 3. Use Microsoft Tasks
curl -s "http://localhost:3500/api/lists?provider=microsoft" \
  -H "Authorization: Bearer <token>" | jq .
```

### Google Tasks (per user)

```bash
# 1. Get the OAuth authorization URL
curl -s http://localhost:3500/auth/google/url \
  -H "Authorization: Bearer <token>" | jq .authUrl

# 2. Open the URL in a browser, sign in, and authorize.
#    The server stores the tokens automatically after the redirect.

# 3. Use Google Tasks
curl -s "http://localhost:3500/api/lists?provider=google" \
  -H "Authorization: Bearer <token>" | jq .
```

### Disconnect a provider

```bash
curl -s -X DELETE http://localhost:3500/auth/provider/google \
  -H "Authorization: Bearer <token>" | jq .
```

### Set default provider

```bash
curl -s -X PATCH http://localhost:3500/auth/default-provider \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"provider": "microsoft"}' | jq .
```

### Check provider connection status

```bash
curl -s http://localhost:3500/auth/providers/status \
  -H "Authorization: Bearer <token>" | jq .
```

Returns a live validation result for each provider (cached 5 minutes).

---

## User Isolation

Each user's data is completely independent:

1. **Microsoft Tasks** — each user's tokens are stored in their own row in `user_credentials`, encrypted with AES-256-GCM. Only their requests use their tokens.
2. **Google Tasks** — same as Microsoft.
3. **Apple Reminders** — accesses the Reminders database of the macOS user running the server process. All server users share the same local Reminders.

### Data storage

User data is stored in PostgreSQL:

| Table | Contents |
|---|---|
| `users` | One row per account — username, bcrypt-hashed password, email, default provider, preferences |
| `user_credentials` | One row per user per provider — access and refresh tokens, AES-256-GCM encrypted |

---

## Multi-User Scenarios

### Multiple team members

```bash
# Alice registers and gets her token
ALICE_TOKEN=$(curl -s -X POST http://localhost:3500/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"alice123"}' | jq -r '.token')

# Bob registers and gets his token
BOB_TOKEN=$(curl -s -X POST http://localhost:3500/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"bob123"}' | jq -r '.token')

# Alice's lists — her providers only
curl -s "http://localhost:3500/api/lists?provider=microsoft" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq .

# Bob's lists — completely separate
curl -s "http://localhost:3500/api/lists?provider=microsoft" \
  -H "Authorization: Bearer $BOB_TOKEN" | jq .
```

---

## Troubleshooting

**"Authentication required"**
Include the `Authorization: Bearer <token>` header. Check that the token has not expired (30 days).

**"Invalid or expired token"**
Log in again with `POST /auth/login` to get a fresh 30-day token. Use `POST /auth/refresh` proactively before expiry.

**"Username already exists"**
Choose a different username, or log in with the existing credentials.

**"Microsoft credentials not found"**
The user has not completed the OAuth flow. Get the URL from `GET /auth/microsoft/url` and open it in a browser.

**"Google credentials not found"**
Same as above — use `GET /auth/google/url`.

**Users seeing each other's tasks**
This should not happen. Each user's credentials are in separate database rows and are only loaded for the authenticated user. Verify you are using the correct token for each user.
