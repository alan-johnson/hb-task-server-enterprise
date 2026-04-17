# Security Audit — UpQ Enterprise Server

**Date:** 2026-03-23
**Scope:** Full source code review — authentication, API endpoints, database layer,
provider integrations, bridge server, client-side HTML/JS, dependencies.

**Summary:** 17 confirmed vulnerabilities across 9 files.
- 2 Critical
- 7 High
- 6 Medium
- 3 Low (plus 1 Medium added from client-side review = 7 Medium total)

---

## CRITICAL

### C1 — Hardcoded JWT Secret Fallback
**File:** `src/auth/authService.js:5`
```js
this.jwtSecret = jwtSecret || 'your-secret-key-change-in-production';
```
If `JWT_SECRET` is not set, every instance uses a publicly known string. An attacker can
forge valid tokens and impersonate any user.

**Fix:** Fail fast at startup — throw if the env var is missing or too short:
```js
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
  throw new Error('JWT_SECRET env var is required (min 32 chars)');
```
Also add the same guard for `ENCRYPTION_KEY` in `src/db/db.js`.

---

### C2 — JWT Algorithm Not Pinned (Algorithm Confusion Attack)
**File:** `src/auth/authService.js:10-24`

`jwt.sign()` and `jwt.verify()` both omit the `algorithm` option. An attacker can craft
a token with `alg: "none"` and some library versions will accept it without a signature.

**Fix:**
```js
// sign
{ expiresIn: '30d', algorithm: 'HS256' }

// verify
jwt.verify(token, this.jwtSecret, { algorithms: ['HS256'] })
```

---

## HIGH

### H1 — No Rate Limiting on Auth Endpoints (Brute Force)
**File:** `src/task-server.js:272, 305, 358, 386, 406`

`/auth/login`, `/auth/register`, `/auth/forgot-password`, `/auth/reset-password`, and
`/auth/resend-verification` have no rate limiting. An attacker can attempt unlimited
passwords or flood the email service.

**Fix:** Add `express-rate-limit`:
```js
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);
app.use('/auth/forgot-password', authLimiter);
app.use('/auth/reset-password', authLimiter);
```

---

### H2 — OAuth Tokens Cached in Plaintext
**File:** `src/auth/userService.js:127-132, 148-153`

After decrypting from the database, OAuth `accessToken` and `refreshToken` are written
to the cache (Redis or in-memory) as plaintext JSON. A Redis compromise exposes all
provider tokens for all users.

**Fix:** Remove credential caching entirely. The DB uses AES-256-GCM encryption; the
extra round-trip cost is acceptable. Remove `cache.set` calls in `storeCredentials()`
and `getCredentials()`, and remove the `cache.get` early-return in `getCredentials()`.

---

### H3 — Password Hash Cached in User Object
**File:** `src/auth/userService.js:59-68`

`register()` writes `passwordHash` into the cached user object:
```js
passwordHash: hashedPassword,
await cache.set(`user:id:${userId}`, JSON.stringify(user));
```
**Fix:** Omit `passwordHash` from the cached object. The hash is only needed during
`authenticate()`, which already fetches it directly from the database.

---

### H4 — CORS Defaults to Wildcard `*`
**File:** `src/task-server.js:124-125`
```js
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
```
If `ALLOWED_ORIGIN` is not set, any website can make cross-origin requests to the API.

**Fix:** Require the env var and refuse to start without it:
```js
const allowedOrigin = process.env.ALLOWED_ORIGIN;
if (!allowedOrigin) throw new Error('ALLOWED_ORIGIN env var is required');
```

---

### H5 — Missing HTTP Security Headers
**File:** `src/task-server.js` (no helmet or equivalent)

No `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, or
`Content-Security-Policy` headers are set. Exposes users to clickjacking, MIME sniffing,
and protocol downgrade attacks.

**Fix:** Install and add `helmet` before other middleware:
```js
const helmet = require('helmet');
app.use(helmet());
```

---

### H6 — Vulnerable Dependencies (CVE in `tar`)
**File:** `package.json` (transitive via `@mapbox/node-pre-gyp`)

`npm audit` confirms **high-severity** CVEs in the `tar` package (path traversal and
symlink poisoning — CVSS 7.1–8.2). `@mapbox/node-pre-gyp` is only needed to build
`bcrypt`'s native bindings.

**Fix:**
```bash
npm audit fix
```
If unresolved, remove `bcrypt` entirely — `bcryptjs` (pure JS, already installed) is a
direct drop-in replacement with no native build chain dependency.

---

### H7 — AppleScript Injection in Legacy `apple.js`
**File:** `src/providers/apple.js:75, 113-115`

`listId` and `taskId` are interpolated directly into AppleScript strings without escaping:
```js
if id of aList is "${listId}" then      // line 75
if id of aReminder is "${taskId}" then  // line 115
```
The `escapeString()` helper (line 272) exists but is not called for IDs. A crafted ID
can inject and execute arbitrary AppleScript, which has shell access on macOS.

**Note:** `apple.js` is not referenced by `task-server.js` (which uses `apple-bridge.js`
instead), so this is not an active attack surface. But the file exists in the repo.

**Fix:** Delete `apple.js` (dead code), or apply `this.escapeString()` to all
interpolated values as a minimum.

---

## MEDIUM

### M1 — Password Reset & Verification Tokens Stored Plaintext in DB
**File:** `src/auth/userService.js:190-194, 242-246` / `src/db/schema.sql:16-19`

Both token types are stored as raw 64-character hex strings. A database dump exposes
all live password reset and email verification tokens immediately.

**Fix:** SHA-256 hash the token before storing; compare the hash on lookup:
```js
const hash = crypto.createHash('sha256').update(token).digest('hex');
// store hash in DB, send raw token to user
```

---

### M2 — No Password Strength Validation at Registration
**File:** `src/task-server.js:272-302`

`/auth/reset-password` checks `length < 8`, but `/auth/register` accepts any non-empty
string. Users can register with single-character passwords.

**Fix:** Shared validator called from both endpoints:
```js
function validatePassword(pw) {
  if (!pw || pw.length < 8)
    throw new Error('Password must be at least 8 characters.');
}
```

---

### M3 — Missing DB Indexes on Queried Columns
**File:** `src/db/schema.sql`

Three columns are used in `WHERE` lookups but have no index:
- `email` — `createPasswordResetToken()` queries `WHERE email = ?`
- `verification_token` — `verifyEmailToken()` queries `WHERE verification_token = ?`
- `password_reset_token` — `resetPassword()` queries `WHERE password_reset_token = ?`

Every password reset and email verification does a full table scan.

**Fix:**
```sql
CREATE INDEX idx_users_email               ON users (email);
CREATE INDEX idx_users_verification_token  ON users (verification_token);
CREATE INDEX idx_users_password_reset_token ON users (password_reset_token);
```

---

### M4 — ENCRYPTION_KEY Not Validated at Startup
**File:** `src/db/db.js:36-42`

`getKey()` is only called when `encrypt()` runs — not at boot. A misconfigured
deployment starts fine and crashes on the first credential write.

**Fix:** Call `getKey()` once at module load time so startup fails immediately if the
key is absent or malformed.

---

### M5 — Microsoft Provider Requests Unnecessary `User.Read` Scope
**File:** `src/providers/microsoft.js` (scope config)

The OAuth scope includes `User.Read`, which is never used in provider code.

**Fix:** Remove `User.Read` — keep only `Tasks.ReadWrite offline_access`.

---

### M6 — JWT Expiry of 30 Days
**File:** `src/auth/authService.js:17`

30-day tokens leave a wide exposure window if compromised. The `/auth/refresh` endpoint
already exists, making shorter-lived tokens feasible with no UX regression.

**Fix:** Reduce to 24 hours: `{ expiresIn: '24h', algorithm: 'HS256' }`.

---

### M7 — JWT Stored in localStorage (XSS Exposure)
**File:** All `src/public/*.html` files

`localStorage` is accessible to any JavaScript on the page. A single XSS vulnerability
anywhere on the domain exposes the token.

**Partial Fix:** A strict `Content-Security-Policy` header (via H5 / helmet) limits XSS
exploitability. Full mitigation requires migrating to `httpOnly` cookies — a larger
change flagged for a future sprint.

---

## LOW

### L1 — User ID Uses `Math.random()` (Non-Cryptographic)
**File:** `src/auth/userService.js:45`
```js
const userId = Date.now().toString() + Math.random().toString(36).substring(2);
```
`Math.random()` is not CSPRNG. IDs are also time-prefixed making them partially
predictable.

**Fix:** `const userId = crypto.randomUUID();`

---

### L2 — Bearer Token Extraction Without Trim
**File:** `src/auth/authService.js:43`
```js
const token = authHeader.substring(7);
```
Leading whitespace causes silent rejection.

**Fix:** `const token = authHeader.substring(7).trim();`

---

### L3 — Bridge Connection Replacement Is Silent
**File:** `src/bridge-server.js:99-106`

When a new WebSocket authenticates with the same API key, the old connection is
silently closed. A compromised API key can displace the legitimate local server without
any log entry or alert.

**Fix:** Log the displacement with user ID and timestamp to `app.log`.

---

## Remediation Priority Order

| Priority | ID | Action |
|---|---|---|
| Before any production traffic | C1, C2, H4 | Fail-fast env guards, JWT algorithm pinning, CORS lockdown |
| Before public launch | H1, H2, H3, H5, H6 | Rate limiting, remove credential cache, helmet headers |
| First sprint post-launch | M1, M2, M3, M4, M5 | Token hashing, password validation, DB indexes, startup key check |
| Within 60 days | M6, M7, H7 | JWT expiry, CSP hardening, delete dead apple.js |
| Ongoing / low effort | L1, L2, L3 | randomUUID, trim, bridge logging |

---

## Files to Modify

| File | Findings |
|---|---|
| `src/auth/authService.js` | C1, C2, M6, L2 |
| `src/auth/userService.js` | H2, H3, M1, M2, L1 |
| `src/db/db.js` | C1 (ENCRYPTION_KEY guard), M4 |
| `src/db/schema.sql` | M3 (3 indexes) |
| `src/task-server.js` | H1, H4, H5, M2 |
| `src/providers/microsoft.js` | M5 |
| `src/providers/apple.js` | H7 (delete or fix) |
| `src/bridge-server.js` | L3 |
| `package.json` | H6 (audit fix, add helmet + express-rate-limit) |

---

## Verification Checklist

After all fixes are applied:

```
[ ] Start server without JWT_SECRET → should throw at boot, not at first request
[ ] Start server without ALLOWED_ORIGIN → should throw at boot
[ ] Send token with alg:none header → should return 401
[ ] 25 rapid POST /auth/login → 429 returned after 20 attempts
[ ] Register user, inspect cache → no passwordHash field present
[ ] Inspect getCredentials() → no cache.set call; always reads from DB
[ ] npm audit → 0 high/critical vulnerabilities
[ ] curl -I https://domain/ → X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security present
[ ] Register with 3-char password → 400 error returned
[ ] DB inspection: verification_token column contains SHA-256 hash, not raw token
```
