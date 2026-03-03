# Multi-User Mode Guide

This guide explains how to run the task server in multi-user mode with authentication and user isolation.

## Overview

In multi-user mode:  
- ✅ Each user has their own account with username/password  
- ✅ Users can only access their own tasks (complete isolation)  
- ✅ JWT-based authentication  
- ✅ Each user can connect their own Microsoft/Google accounts  
- ✅ For Apple Reminders, each user accesses their own local Reminders app

## Setup

### 1. Install Dependencies

```bash
npm install
```

This will install the additional dependencies:
- `jsonwebtoken` - for JWT token generation/verification
- `bcrypt` - for password hashing

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set a secure JWT secret:

```
JWT_SECRET=your-long-random-secret-key-at-least-32-characters
DATA_DIR=./data
```

**IMPORTANT:** Change the `JWT_SECRET` to a long, random string in production!

### 3. Start the Multi-User Server

```bash
npm run start:multiuser
```

## User Registration & Authentication

### Register a New User

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "password": "secure-password",
    "email": "alice@example.com"
  }'
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

**Save the token!** You'll need it for all authenticated requests.

### Login (Get a New Token)

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "password": "secure-password"
  }'
```

### Get Current User Info

```bash
curl http://localhost:3000/auth/me \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Using the API with Authentication

All task endpoints now require the `Authorization` header with your JWT token:

```bash
# Get your lists
curl http://localhost:3000/api/lists \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"

# Get tasks from a list
curl "http://localhost:3000/api/lists/LIST_ID/tasks" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"

# Create a task
curl -X POST http://localhost:3000/api/lists/LIST_ID/tasks \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My task",
    "notes": "Task details"
  }'

# Mark task complete
curl -X PATCH "http://localhost:3000/api/lists/LIST_ID/tasks/TASK_ID/complete" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Provider Configuration (Per User)

Each user can connect their own Microsoft Tasks and Google Tasks accounts.

### Apple Reminders

Apple Reminders works automatically - each user accesses their own local Reminders when logged into macOS.

**Important:** If running on a server with multiple macOS user accounts, make sure each user runs the server under their own macOS account to access their personal Reminders.

### Google Tasks (Per User)

1. **Get the authorization URL:**
```bash
curl http://localhost:3000/auth/google/url \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

2. **Open the URL in a browser** and authorize

3. **You'll be redirected** with the credentials saved to your account

4. **Use Google Tasks:**
```bash
curl "http://localhost:3000/api/lists?provider=google" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Microsoft Tasks (Per User)

1. **Get an access token** from Microsoft (use OAuth flow)

2. **Store the token:**
```bash
curl -X POST http://localhost:3000/auth/microsoft/token \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"accessToken": "MICROSOFT_ACCESS_TOKEN"}'
```

3. **Use Microsoft Tasks:**
```bash
curl "http://localhost:3000/api/lists?provider=microsoft" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Disconnect a Provider

```bash
curl -X DELETE http://localhost:3000/auth/provider/google \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Set Default Provider

```bash
curl -X PATCH http://localhost:3000/auth/default-provider \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"provider": "google"}'
```

## User Isolation

### How it Works

1. **Apple Reminders:** Each user's token is tied to their macOS user account. The server executes AppleScript in the context of the user running the server, accessing their local Reminders.

2. **Microsoft Tasks:** Each user's Microsoft access token is stored separately and used only for that user's requests.

3. **Google Tasks:** Each user's Google OAuth tokens are stored separately and used only for that user's requests.

### Data Storage

User data is stored in JSON files in the `./data` directory:

- `users.json` - User accounts (username, hashed password, email)
- `user-credentials.json` - Provider credentials per user (access tokens, refresh tokens)

**Important:** In production, use:
- A proper database (PostgreSQL, MongoDB)
- Encrypted storage for credentials
- Proper session management (Redis)

## Multi-User Scenarios

### Scenario 1: Multiple Team Members

```bash
# Alice registers
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "alice123", "email": "alice@company.com"}'

# Bob registers
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "bob", "password": "bob123", "email": "bob@company.com"}'

# Alice gets her tasks (with her token)
curl http://localhost:3000/api/lists \
  -H "Authorization: Bearer ALICE_TOKEN"

# Bob gets his tasks (with his token) - completely separate from Alice
curl http://localhost:3000/api/lists \
  -H "Authorization: Bearer BOB_TOKEN"
```

### Scenario 2: Same Mac, Different Users

If Alice and Bob both use the same Mac:

1. **Alice logs into macOS** and runs the server
   - Alice's API calls access Alice's Reminders
   
2. **Bob logs into macOS** (different user account) and runs the server on a different port
   - Bob's API calls access Bob's Reminders

## Security Considerations

### In Development:
- File-based storage is fine
- Self-signed JWT is fine

### In Production:
- ❗ Use a strong, random JWT secret (at least 32 characters)
- ❗ Use HTTPS (TLS/SSL)
- ❗ Use a proper database with encryption
- ❗ Implement refresh token rotation
- ❗ Add rate limiting
- ❗ Implement token expiry and refresh
- ❗ Add password reset functionality
- ❗ Use environment-specific secrets management
- ❗ Implement proper logging and monitoring
- ❗ Add two-factor authentication for sensitive accounts

## Testing Multiple Users

Create a test script:

```bash
#!/bin/bash

# Register Alice
ALICE_TOKEN=$(curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"test123"}' \
  | jq -r '.token')

# Register Bob
BOB_TOKEN=$(curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"test123"}' \
  | jq -r '.token')

echo "Alice's token: $ALICE_TOKEN"
echo "Bob's token: $BOB_TOKEN"

# Get Alice's lists
echo "Alice's lists:"
curl -s http://localhost:3000/api/lists \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq

# Get Bob's lists  
echo "Bob's lists:"
curl -s http://localhost:3000/api/lists \
  -H "Authorization: Bearer $BOB_TOKEN" | jq
```

## Troubleshooting

### "Authentication required"
- Make sure you're including the `Authorization: Bearer TOKEN` header
- Check that your token hasn't expired (tokens last 7 days by default)
- Login again to get a fresh token

### "Username already exists"
- Choose a different username
- Or login with the existing credentials

### "Invalid or expired token"
- Your token has expired (7 days)
- Login again to get a new token

### Users seeing each other's tasks
- This should never happen! Each user's credentials are isolated
- Check that you're using the correct token for each user
- Verify the server is running in multi-user mode

## Migration from Single-User

If you have the single-user version running:

1. Stop the single-user server
2. Install new dependencies: `npm install`
3. Update `.env` with JWT_SECRET
4. Start multi-user server: `npm run start:multiuser`
5. Register accounts for your users
6. Each user authenticates and connects their providers

The original single-user server (`npm start`) still works for testing!
