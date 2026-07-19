# UpQ Developer Quickstart

UpQ's REST API triages your Microsoft To Do / Google Tasks / Apple Reminders into **Now / Next / Later** — one call, no per-provider list-structure handling on your end. This gets you a working call in under a minute using seeded sandbox data, then walks through connecting a real account and using the MCP server.

This is the beta path: connect an account, read triage, read/set triage rules. For everything else the API can do (full task CRUD, per-provider list endpoints, settings), see the [full REST API reference](./REST-API.md).

The beta is free — see [Beta program notes](#beta-program-notes) at the bottom for what that means.

---

## 1. Register and mint a sandbox API key

No OAuth, no connected account needed yet.

```bash
curl -X POST https://tasks.handsbreadth.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"yourname","password":"a-strong-password","email":"you@example.com"}'
```

Check your email and click the verification link — it logs you in and hands you a JWT (also usable directly from the URL). Then mint a **sandbox** API key with that JWT:

```bash
curl -X POST https://tasks.handsbreadth.com/auth/api-keys \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-sandbox-key","sandbox":true}'
```

```json
{
  "id": "916d2f89-...",
  "apiKey": "upq_sandbox_Cy0CrTnAKkihoVV0_LL-P6RQJHXdNMbc",
  "prefix": "upq_sandbox_Cy0C",
  "sandbox": true,
  "message": "Store this key securely. It will not be shown again."
}
```

Save `apiKey` — it's shown once. A sandbox key can only ever see sandbox data, never your real connected accounts, even if you connect one later.

## 2. Call the triage endpoint

```bash
curl https://tasks.handsbreadth.com/api/tasks/unified \
  -H "Authorization: Bearer upq_sandbox_..."
```

```json
{
  "tasks": [
    { "id": "sandbox-task-1", "name": "Reply to client escalation", "classification": "now", "listId": "sandbox-list-work", "listName": "Work", "priority": "high", "dueDate": "2026-07-15", ... },
    { "id": "sandbox-task-2", "name": "Prep Q3 roadmap doc", "classification": "next", ... },
    { "id": "sandbox-task-3", "name": "Archive old project files", "classification": "later", ... }
  ],
  "total": 9,
  "hasMore": false
}
```

That's the whole pitch: one endpoint, every task pre-sorted into `now` / `next` / `later`, with `listId`/`listName` on each task so you can scope down without a separate lists API:

```bash
# only one list
curl "https://tasks.handsbreadth.com/api/tasks/unified?list_id=sandbox-list-work" -H "Authorization: Bearer upq_sandbox_..."

# everything except one list
curl "https://tasks.handsbreadth.com/api/tasks/unified?exclude_list=sandbox-list-someday" -H "Authorization: Bearer upq_sandbox_..."

# paginate
curl "https://tasks.handsbreadth.com/api/tasks/unified?limit=20&offset=0" -H "Authorization: Bearer upq_sandbox_..."
```

Sandbox data is mutable — full task CRUD works against it (`POST/PATCH/DELETE /api/lists/:listId/tasks...`, same shapes as real providers), so you can exercise write flows before connecting anything real. Reset it back to the seeded baseline any time:

```bash
curl -X POST https://tasks.handsbreadth.com/api/sandbox/reset -H "Authorization: Bearer upq_sandbox_..."
```

## 3. Connect a real account

OAuth needs a browser — there's no curl-only path for this step. Log into the [web app](https://tasks.handsbreadth.com), go to Settings, and connect Microsoft To Do or Google Tasks. That's the same flow real users go through; nothing beta-specific here.

## 4. Mint a live API key

Once an account is connected, mint a key without `sandbox: true`:

```bash
curl -X POST https://tasks.handsbreadth.com/auth/api-keys \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-live-key"}'
```

`GET /api/tasks/unified` with this key now returns your real triaged tasks. List/manage/revoke keys any time:

```bash
curl https://tasks.handsbreadth.com/auth/api-keys -H "Authorization: Bearer YOUR_JWT"
curl -X DELETE https://tasks.handsbreadth.com/auth/api-keys/KEY_ID -H "Authorization: Bearer YOUR_JWT"
```

By default a key gets both `tasks:read` and `tasks:write`. If your integration only reads (e.g. a dashboard, not an agent that edits tasks), mint a read-only key instead — it gets `403 forbidden` on any write:

```bash
curl -X POST https://tasks.handsbreadth.com/auth/api-keys \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"read-only-dashboard","scopes":["tasks:read"]}'
```

## 5. Read and set triage rules

Rules decide what counts as Now vs Next vs Later — e.g. "overdue or high priority" for Now.

```bash
curl https://tasks.handsbreadth.com/auth/me/classification -H "Authorization: Bearer upq_live_..."
```

```json
{
  "rules": {
    "now":   { "label": "Now",   "overdue": true, "priorities": ["high"] },
    "next":  { "label": "Next",  "future_due": true, "priorities": ["normal"] },
    "later": { "label": "Later" }
  },
  "isCustom": false
}
```

```bash
curl -X PUT https://tasks.handsbreadth.com/auth/me/classification \
  -H "Authorization: Bearer upq_live_..." \
  -H "Content-Type: application/json" \
  -d '{"now":{"overdue":true,"priorities":["high"]},"next":{"future_due":true,"priorities":["normal"]},"later":{}}'
```

For rules that need boolean logic the shape above can't express (e.g. "high priority AND due within 3 days"), use the `schemaVersion: 2` predicate-tree shape instead — export your current rules, edit the file in VS Code (autocomplete/validation comes free from the `$schema` field in the exported file), validate, then import. See [Editing classification rules in VS Code](./REST-API.md#editing-classification-rules-in-vs-code) in the full reference for the walkthrough.

## 6. MCP server

The same triage/rules tools are available as an MCP server, for agents that speak MCP directly rather than calling REST.

**Stdio** (run locally, e.g. as a Claude Desktop/Code MCP server) — from a checkout of this repo:

```bash
git clone https://github.com/alan-johnson/hb-task-server-enterprise.git && cd hb-task-server-enterprise && npm install
UPQ_API_BASE_URL=https://tasks.handsbreadth.com UPQ_API_KEY=upq_live_... npm run start:mcp
```

Example MCP client config:

```json
{
  "mcpServers": {
    "upq": {
      "command": "node",
      "args": ["/path/to/hb-task-server-enterprise/src/mcp-server.js"],
      "env": { "UPQ_API_BASE_URL": "https://tasks.handsbreadth.com", "UPQ_API_KEY": "upq_live_..." }
    }
  }
}
```

**Hosted** (no local process — Streamable HTTP at `/mcp`, same Bearer API key). For Claude Code, this is one command — no config file to hand-edit:

```bash
claude mcp add --transport http upq https://tasks.handsbreadth.com/mcp --header "Authorization: Bearer upq_live_..."
```

Other clients (e.g. Claude Desktop) still need the config added directly to their MCP config file:

```json
{
  "mcpServers": {
    "upq": {
      "type": "http",
      "url": "https://tasks.handsbreadth.com/mcp",
      "headers": { "Authorization": "Bearer upq_live_..." }
    }
  }
}
```

Both of the above, pre-filled with your actual key (no placeholder to swap out), are generated automatically in the "API Key Created" dialog right after you mint a key on the [Developer page](/developer.html).

Three tools ship in the beta: `get_triage`, `get_rules`, `set_rules` — the same surface as the REST quickstart above, kept intentionally small. Full task CRUD already exists on the REST API and is cheap to add as MCP tools; ask if you need it.

## 7. Everything else

Full endpoint reference, error codes, rate limits, and the local (`hb-task-server`, no auth, Apple Reminders only) vs enterprise (this API) split: **[REST-API.md](./REST-API.md)**.

---

## Beta program notes

- **Free during the beta** — no billing is wired up. We'll ask what you'd expect to pay (per call, per connected account, flat tier) directly rather than guess.
- **Rate limit**: 120 requests/minute per account, shared across all your keys. Returns `429` with `{"error":{"code":"rate_limited","message":"..."}}` if exceeded.
- **Scopes**: keys get `tasks:read`+`tasks:write` by default; mint a `tasks:read`-only key if you don't need writes. Enforced, not just labeling — GET needs `tasks:read`, everything else needs `tasks:write`, or you get `403`.
- **Idempotency**: send an `Idempotency-Key` header on any task write (create/update/complete/delete) to make retries safe — same key + same body replays the original response instead of repeating the write; same key + a different body returns `400`.
- **Errors** on the routes above use `{"error":{"code":"...","message":"..."}}` with a small fixed set of codes: `unauthorized`, `forbidden`, `invalid_request`, `not_found`, `rate_limited`, `provider_error`, `internal_error`.
- **Pagination**: only `GET /api/tasks/unified` supports `?limit=&offset=` today; other endpoints return full results.
- **Usage logging**: we log API call metadata (endpoint, timestamp, status code) per key to understand which developers get value from triage vs. raw task pulls — this is server-side beta-program telemetry about your own calls, not client-side tracking, and separate from the [privacy policy](https://tasks.handsbreadth.com/privacy)'s no-tracking commitment for the web app.
- **Sandbox limitation**: sandbox task data is held in memory per key and isn't guaranteed to survive a server restart — don't rely on it for anything you need to persist.
