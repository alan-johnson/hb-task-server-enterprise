# Handsbreadth Task Server — Namecheap Shared Hosting (cPanel) Deployment Guide

This guide covers deploying the multi-user task server to Namecheap shared hosting using
cPanel. It replaces the VPS-oriented steps in DEPLOY.md, which assumes root access and
manual nginx/PM2 configuration that is not available on shared hosting.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Resolve the bcrypt Dependency](#2-resolve-the-bcrypt-dependency)
3. [Create the MySQL Database](#3-create-the-mysql-database)
4. [Upload the Application Files](#4-upload-the-application-files)
5. [Configure the Node.js App in cPanel](#5-configure-the-nodejs-app-in-cpanel)
6. [Set Environment Variables](#6-set-environment-variables)
7. [Install Dependencies](#7-install-dependencies)
8. [Enable SSL](#8-enable-ssl)
9. [Update OAuth Redirect URIs](#9-update-oauth-redirect-uris)
10. [Verify the Deployment](#10-verify-the-deployment)
11. [External Service Setup](#11-external-service-setup)
12. [Ongoing Maintenance](#12-ongoing-maintenance)
13. [Known Limitations](#13-known-limitations)

---

## 1. Prerequisites

Before starting, confirm your Namecheap plan includes:

- **Node.js support** — available on Stellar Plus and higher shared hosting plans
- **MySQL support** — available on all shared hosting plans; confirm in cPanel under
  "MySQL Databases"
- A **domain name** pointed at your Namecheap hosting account (required for OAuth
  redirect URIs)

You do not need Redis. Without it, the server reads directly from MySQL, which is
the correct configuration for a single-instance shared hosting deployment. Leave
`REDIS_URL` unset.

---

## 2. Resolve the bcrypt Dependency

The `bcrypt` package (listed in `package.json`) compiles a native C++ module during
`npm install`. Namecheap shared hosting does not provide the build tools (`gcc`, `python3`,
`make`) required for this compilation, so `npm install` will fail with a node-gyp error.

**The fix is to replace `bcrypt` with `bcryptjs`**, a pure-JavaScript drop-in replacement
with an identical API. Make these two changes before uploading the files:

### 2.1 Update package.json

In `package.json`, change:
```json
"bcrypt": "^5.1.1",
```
to:
```json
"bcryptjs": "^2.4.3",
```

### 2.2 Update the import in userService.js

In `src/auth/userService.js`, change line 1:
```js
const bcrypt = require('bcrypt');
```
to:
```js
const bcrypt = require('bcryptjs');
```

No other code changes are needed. The `bcrypt.hash()` and `bcrypt.compare()` calls on
lines 30 and 65 are identical in both packages.

### 2.3 Remove the local node_modules directory

Do not upload your local `node_modules/` folder. Delete it or exclude it from your upload
(see Section 4). The server will install a clean set of dependencies via cPanel after the
files are uploaded.

---

## 3. Create the MySQL Database

1. Log in to cPanel at `https://your-domain.com/cpanel` (or via Namecheap dashboard >
   cPanel).
2. Go to **Databases** > **MySQL Databases**.
3. Under **Create New Database**, enter a name (e.g., `taskserver`). cPanel will prefix
   it with your cPanel username automatically, producing something like
   `cpanelusername_taskserver`.
4. Under **MySQL Users** > **Add New User**, create a user (e.g., `taskapp`) with a
   strong password. Note the full prefixed username (e.g., `cpanelusername_taskapp`).
5. Under **Add User to Database**, select the new user and new database, then click **Add**.
   Grant **ALL PRIVILEGES**.
6. Note your full connection string — you will need it in Section 6:
   ```
   mysql://cpanelusername_taskapp:yourpassword@localhost:3306/cpanelusername_taskserver
   
   mysql://handfrgi_taskapp:bifpoq-rYdbij-1wuwze@localhost:3306/handfrgi_upq-taskserver
   ```

The application creates its own schema tables on first boot. No manual SQL setup is needed.

---

## 4. Upload the Application Files

Upload the project directory to your hosting account. Exclude `node_modules/`, `.env`,
and any local development files.

### Option A: FTP/SFTP (recommended for initial upload)

Use an FTP client such as FileZilla with your Namecheap FTP credentials (found in cPanel
under **FTP Accounts**).

- Upload to a directory **outside** `public_html`, for example `/home/cpanelusername/hb-task-server`.
  This keeps application files (including any `.env` file you create later) inaccessible
  from the web.
- Do **not** upload `node_modules/` — it will be installed by cPanel in Section 7.

### Option B: cPanel File Manager

Navigate to cPanel > **File Manager**, create the directory, and upload a zip archive of
the project. Use **Extract** to unzip it.

### Option C: Git (if available on your plan)

cPanel's **Git Version Control** tool can clone directly from a repository. Check whether
your plan includes it under cPanel > **Files** > **Git Version Control**.

---

## 5. Configure the Node.js App in cPanel

1. In cPanel, go to **Software** > **Setup Node.js App**.
2. Click **Create Application**.
3. Fill in the form:

   | Field | Value |
   |---|---|
   | **Node.js version** | Choose 18.x or later |
   | **Application mode** | Production |
   | **Application root** | `/home/cpanelusername/hb-task-server` (the directory from Section 4) |
   | **Application URL** | Select your domain (e.g., `your-domain.com`) |
   | **Application startup file** | `src/server.js` |

4. Click **Create**. cPanel will configure Passenger to proxy requests to your Node.js app.

> **Note on PORT:** Passenger automatically sets the `PORT` environment variable to the
> port it assigns to your app. The server reads `process.env.PORT` at startup, so this
> works correctly without any manual configuration.

---

## 6. Set Environment Variables

In cPanel > **Setup Node.js App**, open your application and scroll to the **Environment
Variables** section. Add each variable below. Do not create a `.env` file on the server —
setting variables here keeps secrets out of the filesystem.

| Variable | Value |
|---|---|
| `JWT_SECRET` | A 128-character random hex string (see generation command below) |
| `DATABASE_URL` | `mysql://cpanelusername_taskapp:PASS@localhost:3306/cpanelusername_taskserver` |
| `ENCRYPTION_KEY` | A 64-character random hex string (see generation command below) |
| `MICROSOFT_CLIENT_ID` | Your Azure App Registration client ID |
| `MICROSOFT_CLIENT_SECRET` | Your Azure App Registration client secret |
| `MICROSOFT_TENANT_ID` | `consumers` for personal accounts; your tenant GUID to restrict to one org |
| `MICROSOFT_REDIRECT_URI` | `https://your-domain.com/auth/microsoft/callback` |
| `GOOGLE_CLIENT_ID` | Your Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Your Google OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | `https://your-domain.com/auth/google/callback` |
| `DEFAULT_PROVIDER` | `microsoft` or `google` |
| `WEB_URL` | `https://your-domain.com` |

**Do not set** `REDIS_URL` — Redis is not available on shared hosting. Without it, all reads go directly to MySQL, which is correct for this deployment.
**Do not set** `ENABLE_APPLE_PROVIDER` — Apple Reminders requires macOS.

### Generating secret values

Run these locally (on your Mac) to generate the required secrets:

```bash
# JWT_SECRET — 128 hex characters
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# ENCRYPTION_KEY — 64 hex characters
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output directly into the cPanel environment variable fields.

---

## 7. Install Dependencies

1. In cPanel > **Setup Node.js App**, open your application.
2. Click **Run NPM Install**. cPanel will run `npm install --omit=dev` in your application
   root.
3. Watch for errors. If the install succeeds, you will see a success message. If it fails,
   the most likely cause is the `bcrypt` native module — confirm you completed Section 2.
   The `mysql2` package is pure JavaScript and installs without build tools.
4. After a successful install, click **Restart** to start the application.

---

## 8. Enable SSL

Namecheap provides free SSL via AutoSSL (Let's Encrypt) for all domains on shared hosting.

1. In cPanel, go to **Security** > **SSL/TLS Status**.
2. Check the box next to your domain and click **Run AutoSSL**.
3. AutoSSL renews certificates automatically — no cron jobs or manual renewal needed.

Once SSL is active, your app is accessible at `https://your-domain.com`. HTTP traffic is
redirected to HTTPS by Namecheap's Apache configuration automatically.

---

## 9. Update OAuth Redirect URIs

After SSL is active, update the redirect URIs in each OAuth provider's developer console
to use your actual domain. These must match exactly what you set in Section 6.

### Microsoft Azure

1. Go to portal.azure.com > **Microsoft Entra ID** > **App registrations** > your app.
2. Under **Authentication** > **Redirect URIs**, replace any localhost URI with:
   ```
   https://your-domain.com/auth/microsoft/callback
   ```

### Google Cloud

1. Go to console.cloud.google.com > **APIs & Services** > **Credentials** > your OAuth client.
2. Under **Authorized redirect URIs**, replace any localhost URI with:
   ```
   https://your-domain.com/auth/google/callback
   ```

---

## 10. Verify the Deployment

Run these checks after the app is started. Replace `your-domain.com` with your actual domain.

### Health check

```bash
curl -s https://your-domain.com/health | jq .
```

Expected:
```json
{ "status": "ok", "timestamp": "..." }
```

### Available providers

```bash
curl -s https://your-domain.com/api/providers | jq .
```

Expected:
```json
{ "providers": ["microsoft", "google"], "default": "microsoft" }
```

### User registration

```bash
curl -s -X POST https://your-domain.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "TestPass123!", "email": "test@example.com"}' \
  | jq .
```

Expected: `201` response with a `token` field.

### Reject unauthenticated requests

```bash
curl -s -o /dev/null -w "%{http_code}" https://your-domain.com/api/lists
```

Expected output: `401`

---

## 11. External Service Setup

See DEPLOY.md Sections 4.1 (Microsoft Azure) and 4.2 (Google Cloud) for step-by-step
instructions on creating OAuth credentials. The steps are identical regardless of hosting
provider — the only difference is that your redirect URIs use your Namecheap domain
instead of a VPS IP address or localhost.

---

## 12. Ongoing Maintenance

### Restarting after a code change

1. Upload changed files via FTP or File Manager.
2. If `package.json` changed, run **NPM Install** again in cPanel > Setup Node.js App.
3. Click **Restart** in cPanel > Setup Node.js App.

Passenger does not hot-reload on file changes — a manual restart is always required.

### Viewing logs

cPanel shared hosting does not provide application-level log access equivalent to
`pm2 logs`. Use cPanel > **Logs** > **Error Log** to see uncaught exceptions and
Node.js startup errors written to the Apache error log.

For more detailed logging, consider adding file-based logging to the application (e.g.,
writing to a log file in your application directory) and viewing those files via File Manager.

### MySQL backups

cPanel > **Backup** or **Backup Wizard** can produce a full account backup that includes
MySQL databases. For scheduled automated backups, Namecheap's **JetBackup** (if
included on your plan) can back up databases on a daily schedule. Verify this is enabled
under cPanel > **JetBackup**.

---

## 13. Known Limitations

These limitations apply specifically to shared hosting. Some are inherited from the
codebase itself (also documented in DEPLOY.md Section 8); others are constraints of the
shared hosting environment.

| # | Limitation | Impact | Notes |
|---|---|---|---|
| 1 | No Redis available | Low — single instance only | Correct for shared hosting; do not set `REDIS_URL`. All reads go to MySQL. |
| 2 | No OAuth token refresh | High — users get errors after ~1 hour | Requires code change: catch 401, call refresh endpoint, store new token, retry |
| 3 | No rate limiting | High — brute-force risk on `/auth/login` | Requires code change: add `express-rate-limit` |
| 4 | No application log access | Medium — debugging is harder | Work around with file-based logging or cPanel error log |
| 5 | Cannot run multiple instances | Low — no horizontal scaling | Single Passenger process only; acceptable for small deployments |
| 6 | 30-day JWT expiry, no revocation | Low — stolen tokens valid up to 30 days | Reduce expiry or add a JTI revocation list |
| 7 | OAuth callback state is unsigned | Medium — CSRF risk on OAuth redirect | Requires code change: sign state with HMAC or use server-side session |
