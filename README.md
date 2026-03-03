# Unified Task Server

A REST API server that integrates with Apple Reminders, Microsoft Tasks, and Google Tasks, providing a unified interface for task management across all three platforms.

## Features

- ✅ **Apple Reminders** - Native integration via AppleScript (no authentication needed)
- ✅ **Microsoft Tasks** - Integration via Microsoft Graph API
- ✅ **Google Tasks** - Integration via Google Tasks API
- ✅ Unified REST API for all providers
- ✅ Get task lists
- ✅ Get tasks within a list
- ✅ Get task details
- ✅ Mark tasks as complete
- ✅ Create new tasks
- ✅ **Multi-User Support** - JWT authentication with complete user isolation (see [MULTIUSER.md](MULTIUSER.md))

## Two Modes Available

1. **Single-User Mode** (`npm start`) - Simple mode for personal use, no authentication required
2. **Multi-User Mode** (`npm run start:multiuser`) - Full authentication with user isolation - see [MULTIUSER.md](MULTIUSER.md)

This README covers **Single-User Mode**. For multi-user setup, see [MULTIUSER.md](MULTIUSER.md).

## Prerequisites

- **Node.js** (v14 or later)
- **macOS** (for Apple Reminders integration)
- **Microsoft Azure account** (for Microsoft Tasks)
- **Google Cloud account** (for Google Tasks)

## Installation

1. **Clone or download the project**
   ```bash
   cd task-server
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and add your credentials (see Configuration section below).

## Configuration

### Apple Reminders

No configuration needed! Apple Reminders works out of the box on macOS using AppleScript.

The first time you run the server, macOS may prompt you to grant Terminal (or your terminal app) access to Reminders. Click "OK" to allow access.

### Microsoft Tasks

1. **Register an application in Azure AD:**
   - Go to [Azure Portal](https://portal.azure.com)
   - Navigate to "Azure Active Directory" > "App registrations"
   - Click "New registration"
   - Name: "Task Server"
   - Redirect URI: `http://localhost:3000/auth/microsoft/callback`
   - Click "Register"

2. **Configure API permissions:**
   - Go to "API permissions"
   - Add permission > Microsoft Graph > Delegated permissions
   - Select: `Tasks.ReadWrite`
   - Grant admin consent

3. **Create a client secret:**
   - Go to "Certificates & secrets"
   - Click "New client secret"
   - Copy the value immediately (you won't be able to see it again)

4. **Update .env file:**
   ```
   MICROSOFT_CLIENT_ID=<your_application_id>
   MICROSOFT_CLIENT_SECRET=<your_client_secret>
   MICROSOFT_TENANT_ID=<your_tenant_id>
   ```

### Google Tasks

1. **Create a project in Google Cloud Console:**
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Create a new project or select an existing one

2. **Enable Google Tasks API:**
   - Navigate to "APIs & Services" > "Library"
   - Search for "Google Tasks API"
   - Click "Enable"

3. **Create OAuth 2.0 credentials:**
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Application type: "Web application"
   - Authorized redirect URIs: `http://localhost:3000/auth/google/callback`
   - Click "Create"

4. **Update .env file:**
   ```
   GOOGLE_CLIENT_ID=<your_client_id>
   GOOGLE_CLIENT_SECRET=<your_client_secret>
   ```

## Running the Server

```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

The server will start on `http://localhost:3000` (or the port specified in your .env file).

## API Documentation

### Authentication

#### Apple Reminders
No authentication required. Works automatically on macOS.

#### Google Tasks
1. Get the authorization URL:
   ```bash
   curl http://localhost:3000/auth/google/url
   ```

2. Open the URL in a browser and authorize the application

3. You'll be redirected to the callback URL with a session ID

4. Use the session ID in subsequent requests:
   ```bash
   curl -H "X-Session-ID: <session_id>" http://localhost:3000/api/lists?provider=google
   ```

#### Microsoft Tasks
1. Obtain an access token using your preferred OAuth flow

2. Store the token:
   ```bash
   curl -X POST http://localhost:3000/auth/microsoft/token \
     -H "Content-Type: application/json" \
     -d '{"accessToken": "<your_token>"}'
   ```

3. Use the session ID in subsequent requests:
   ```bash
   curl -H "X-Session-ID: <session_id>" http://localhost:3000/api/lists?provider=microsoft
   ```

### Endpoints

All endpoints support a `provider` query parameter: `?provider=apple`, `?provider=microsoft`, or `?provider=google`

#### Get Available Providers
```bash
GET /api/providers
```

#### Get All Task Lists
```bash
GET /api/lists?provider=apple

# Examples:
curl http://localhost:3000/api/lists?provider=apple
curl http://localhost:3000/api/lists?provider=microsoft -H "X-Session-ID: <session_id>"
curl http://localhost:3000/api/lists?provider=google -H "X-Session-ID: <session_id>"
```

Response:
```json
{
  "provider": "apple",
  "lists": [
    {
      "id": "x-apple-reminder://...",
      "name": "Personal"
    },
    {
      "id": "x-apple-reminder://...",
      "name": "Work"
    }
  ]
}
```

#### Get Tasks in a List
```bash
GET /api/lists/:listId/tasks?provider=apple

# Example:
curl "http://localhost:3000/api/lists/x-apple-reminder://ABC123/tasks?provider=apple"
```

Response:
```json
{
  "provider": "apple",
  "listId": "x-apple-reminder://ABC123",
  "tasks": [
    {
      "id": "x-apple-reminder://ABC123/DEF456",
      "name": "Buy groceries",
      "completed": false,
      "notes": "Milk, eggs, bread",
      "dueDate": "2026-02-05"
    }
  ]
}
```

#### Get Task Details
```bash
GET /api/lists/:listId/tasks/:taskId?provider=apple

# Example:
curl "http://localhost:3000/api/lists/x-apple-reminder://ABC123/tasks/x-apple-reminder://ABC123/DEF456?provider=apple"
```

#### Create a New Task
```bash
POST /api/lists/:listId/tasks?provider=apple
Content-Type: application/json

{
  "name": "New task",
  "notes": "Task description",
  "dueDate": "2026-02-10"
}

# Example:
curl -X POST "http://localhost:3000/api/lists/x-apple-reminder://ABC123/tasks?provider=apple" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Call dentist",
    "notes": "Schedule annual checkup"
  }'
```

#### Mark Task as Complete
```bash
PATCH /api/lists/:listId/tasks/:taskId/complete?provider=apple

# Example:
curl -X PATCH "http://localhost:3000/api/lists/x-apple-reminder://ABC123/tasks/x-apple-reminder://ABC123/DEF456/complete?provider=apple"
```

Response:
```json
{
  "provider": "apple",
  "listId": "x-apple-reminder://ABC123",
  "taskId": "x-apple-reminder://ABC123/DEF456",
  "success": true,
  "message": "Task marked as complete"
}
```

## Usage Examples

### Using with curl

```bash
# Get all lists from Apple Reminders
curl http://localhost:3000/api/lists?provider=apple

# Get tasks from Microsoft Tasks (with authentication)
curl -H "X-Session-ID: xyz123" \
  http://localhost:3000/api/lists/AAMkAD.../tasks?provider=microsoft

# Create a task in Google Tasks
curl -X POST \
  -H "X-Session-ID: abc789" \
  -H "Content-Type: application/json" \
  -d '{"name": "Review PR", "notes": "Check the new feature branch"}' \
  http://localhost:3000/api/lists/MTIzNDU2Nzg5/tasks?provider=google

# Complete a task
curl -X PATCH \
  http://localhost:3000/api/lists/x-apple-reminder://ABC/tasks/x-apple-reminder://ABC/DEF/complete?provider=apple
```

### Using with JavaScript/Fetch

```javascript
// Get lists
const response = await fetch('http://localhost:3000/api/lists?provider=apple');
const data = await response.json();
console.log(data.lists);

// Create a task
const createTask = await fetch(
  'http://localhost:3000/api/lists/LIST_ID/tasks?provider=apple',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'New Task',
      notes: 'Task description'
    })
  }
);
const newTask = await createTask.json();

// Mark as complete
await fetch(
  `http://localhost:3000/api/lists/LIST_ID/tasks/${newTask.task.id}/complete?provider=apple`,
  { method: 'PATCH' }
);
```

## Troubleshooting

### Apple Reminders

**Problem:** "AppleScript error: Not authorized"
- **Solution:** Grant Terminal access to Reminders in System Settings > Privacy & Security > Automation

**Problem:** Lists or tasks not appearing
- **Solution:** Make sure you have lists and tasks in the Reminders app

### Microsoft Tasks

**Problem:** "Client not initialized"
- **Solution:** Make sure you've authenticated and are sending the X-Session-ID header

**Problem:** "Access token expired"
- **Solution:** Obtain a new access token and update it via `/auth/microsoft/token`

### Google Tasks

**Problem:** "Authentication required"
- **Solution:** Complete the OAuth flow at `/auth/google/url` first

**Problem:** "Invalid grant"
- **Solution:** Your authorization code may have expired. Get a new one from `/auth/google/url`

## Architecture

```
task-server/
├── src/
│   ├── server.js                 # Main Express server
│   └── providers/
│       ├── apple.js              # Apple Reminders integration
│       ├── microsoft.js          # Microsoft Tasks integration
│       └── google.js             # Google Tasks integration
├── package.json
├── .env.example
└── README.md
```

## Security Considerations

- This is a development server. For production use:
  - Implement proper session management (Redis, database)
  - Use HTTPS
  - Add rate limiting
  - Implement proper error handling
  - Add request validation
  - Store credentials securely (use environment variables or secrets manager)
  - Implement token refresh logic for Microsoft and Google

## Future Enhancements

- [ ] Update tasks
- [ ] Delete tasks
- [ ] Task priorities
- [ ] Task categories/tags
- [ ] Subtasks
- [ ] Recurring tasks
- [ ] Full OAuth flows for Microsoft
- [ ] Webhooks for task updates
- [ ] Batch operations

## License

MIT

## Contributing

Feel free to submit issues and enhancement requests!
