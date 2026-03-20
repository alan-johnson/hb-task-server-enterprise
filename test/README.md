# Integration Tests

End-to-end tests that run against a live instance of `hb-task-server-enterprise`. Tests run sequentially — each one builds on state produced by the previous.

---

## Setup

1. Copy the environment template and fill in your credentials:

   ```bash
   cp test/.env.example test/.env
   ```

2. Edit `test/.env`:

   ```
   BASE_URL=https://tasks.handsbreadth.com
   TEST_USER=admin
   TEST_PASS=your-password-here
   ```

   | Variable   | Description                                      | Default                             |
   |------------|--------------------------------------------------|-------------------------------------|
   | `BASE_URL` | URL of the enterprise server to test against     | `https://tasks.handsbreadth.com`    |
   | `TEST_USER` | Username to authenticate with                   | `admin`                             |
   | `TEST_PASS` | Password for the test user                      | _(empty — must be set)_             |

> `test/.env` is listed in `.gitignore` and will never be committed.

---

## Running the Tests

**Against localhost** (default — `BASE_URL=http://localhost:3500` in `test/.env`):

```bash
npm test
```

**Against the production server:**

Set `BASE_URL=https://tasks.handsbreadth.com` in `test/.env`, then:

```bash
npm test
```

> **Note:** HTTPS tests must be run from a machine with working SSL connectivity
> to the production server. On macOS, the system OpenSSL may fail to negotiate
> TLS with Cloudflare — if you see `packet length too long`, run the tests via
> SSH on the Namecheap server or from a Linux machine instead.

**On the Namecheap server via SSH:**

Namecheap's Node.js environment must be activated before running the tests.
Run both commands from the app root (`~/upq/`):

```bash
source /opt/alt/alt-nodejs20/enable
node test/test-integration.js
```

The first command loads Node.js 20 into the current shell session — it must be
run every time you open a new SSH session before using `node` or `npm`.
The second command runs the tests.

**Directly with Node.js (local):**

```bash
node test/test-integration.js
```

---

## Test Descriptions

### Test 1 — Login + Retrieve All Lists

Verifies authentication and that all authorized providers return their lists.

| Step | What is checked |
|------|----------------|
| Health check | `GET /health` returns `{ status: "ok" }` |
| Login | `POST /auth/login` returns a JWT token |
| Identity | `GET /auth/me` confirms the token belongs to the expected user |
| Provider status | `GET /auth/providers/status` returns at least one connected provider |
| Lists per provider | `GET /api/lists?provider=<name>` returns an array of lists for each connected provider |

**Prerequisite:** At least one provider (Microsoft, Google, or Apple) must be authorized in Settings before running.

---

### Test 2 — Retrieve Tasks from One List per Provider

For each connected provider, picks its first list and fetches all tasks from it.

| Step | What is checked |
|------|----------------|
| Tasks request | `GET /api/lists/:listId/tasks?provider=<name>` returns 200 |
| Response shape | `tasks` field is an array |
| Task fields | Each task is printed with name, due date (if set), and classification bucket |

**Prerequisite:** Test 1 must pass and return at least one list.

---

### Test 3 — Retrieve Full Task Detail

Takes the first task found in Test 2 and fetches its full detail record.

| Step | What is checked |
|------|----------------|
| Detail request | `GET /api/lists/:listId/tasks/:taskId?provider=<name>` returns 200 |
| `id` field | Matches the task ID used in the request |
| `name` field | Present and is a string |
| `completed` field | Present in the response |
| Full output | All non-null fields are printed to the console and log |

**Prerequisite:** Test 2 must return at least one task with an `id`.

---

## Output and Logs

All console output — including pass/fail results, task listings, warnings, and errors — is written to both:

- **stdout** — visible in the terminal during the run
- **`test/test-integration.log`** — appended on every run with a timestamped header

Each run in the log is separated by a header like:

```
══════════════════════════════════════════════════════════════
Test run: 2026-03-20T19:00:00.000Z
══════════════════════════════════════════════════════════════
```

> `test-integration.log` is listed in `.gitignore` and will never be committed.

---

## Interpreting Results

```
  ✓  Server healthy (https://tasks.handsbreadth.com)
  ✓  Logged in as "admin"
  ✗  No providers are authorized — re-authorize at least one in Settings and re-run
```

| Symbol | Meaning |
|--------|---------|
| `✓` | Assertion passed |
| `✗` | Assertion failed — detail is printed on the next line |

The process exits with code `0` if all assertions pass, or `1` if any fail.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Login failed` | Wrong credentials in `test/.env` | Update `TEST_USER` / `TEST_PASS` |
| `No providers are authorized` | OAuth tokens expired or never connected | Re-authorize providers in Settings |
| `GET /api/lists failed` — `Invalid Credentials` | Google/Microsoft token expired | Re-authorize the provider in Settings |
| `GET /api/lists failed` — `bridge is not connected` | Apple — `hb-task-server` not running | Start `hb-task-server` with a valid `BRIDGE_API_KEY` |
| `Server health check failed` | Server is down or `BASE_URL` is wrong | Check `BASE_URL` in `test/.env` and verify the server is running |
| Test 2 or 3 shows `Skipped` | An earlier test failed and left no state | Fix the failing test first, then re-run |
