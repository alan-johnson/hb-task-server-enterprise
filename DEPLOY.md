# Handsbreadth Task Server — Enterprise Deployment Guide

This guide covers deploying the multi-user task server to a hosted Linux server with Node.js
installed. It includes installation, configuration, verification, and the full set of components
needed for a production-grade enterprise deployment.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Install the Application](#2-install-the-application)
3. [Configuration](#3-configuration)
4. [External Service Setup](#4-external-service-setup)
5. [Start the Server](#5-start-the-server)
6. [Verification Scripts](#6-verification-scripts)
7. [Enterprise Architecture Components](#7-enterprise-architecture-components)
8. [Known Limitations to Resolve Before Production](#8-known-limitations-to-resolve-before-production)

---

## 1. Prerequisites

### Server requirements

- Linux (Ubuntu 22.04 LTS recommended)
- Node.js 18 or later
- npm 9 or later
- MySQL 8 or later (storage backend)
- Redis (optional — for multi-instance shared cache)
- A domain name pointed at the server (required for OAuth redirect URIs)
- Ports 80 and 443 open in the firewall (for HTTPS via reverse proxy)

### Check Node.js version

```bash
node --version   # must be v18.0.0 or later
npm --version
```

### Build tools required by `bcrypt`

The `bcrypt` package compiles a native module. Install the toolchain before running `npm install`:

```bash
# Ubuntu / Debian
sudo apt-get update
sudo apt-get install -y build-essential python3

# Amazon Linux / RHEL
sudo yum groupinstall "Development Tools"
sudo yum install -y python3
```

---

## 2. Install the Application

```bash
# Copy the application to the server (adjust source path as needed)
scp -r ./hb-task-server user@your-server:/opt/hb-task-server

# Or clone from your repository
git clone <repo-url> /opt/hb-task-server

# Enter the application directory
cd /opt/hb-task-server

# Install production dependencies
npm install --omit=dev
```

### Install and configure MySQL

```bash
sudo apt-get install -y mysql-server

# Start and enable MySQL
sudo systemctl enable --now mysql

# Secure the installation and set root password
sudo mysql_secure_installation

# Create the application database and user
sudo mysql <<'SQL'
CREATE DATABASE IF NOT EXISTS hb_task_server CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'hbtask'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON hb_task_server.* TO 'hbtask'@'localhost';
FLUSH PRIVILEGES;
SQL
```

The application applies the database schema automatically on first boot — no manual migration step is needed.

### Install Redis (optional)

Required only for multi-instance deployments. Without it, the server reads directly from PostgreSQL.

```bash
sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server
```

---

## 3. Configuration

### 3.1 Create the `.env` file

```bash
cp .env.example .env
chmod 600 .env   # restrict read access
```

Edit `.env` with your values:

```ini
# Server — default port is 3500; set explicitly if you need a different port
PORT=3500

# Security — generate a strong random secret:
#   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=<64-character-random-hex-string>

# Database
DATABASE_URL=mysql://hbtask:choose-a-strong-password@localhost:3306/hb_task_server

# Token encryption key (AES-256-GCM) — must be a 64-character hex string:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=<64-character-hex-string>

# Redis cache (optional — required only for multi-instance deployments)
# REDIS_URL=redis://localhost:6379

# Microsoft Tasks (see Section 4.1)
MICROSOFT_CLIENT_ID=<azure-app-client-id>
MICROSOFT_CLIENT_SECRET=<azure-app-client-secret>
MICROSOFT_TENANT_ID=<azure-tenant-id>
MICROSOFT_REDIRECT_URI=https://your-domain.com/auth/microsoft/callback

# Google Tasks (see Section 4.2)
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_REDIRECT_URI=https://your-domain.com/auth/google/callback

# Default provider for new users (microsoft or google)
DEFAULT_PROVIDER=microsoft

# Apple Reminders — do NOT enable on a Linux server (macOS/AppleScript only)
# ENABLE_APPLE_PROVIDER=false
```

> **Do not set `ENABLE_APPLE_PROVIDER=true` on a Linux server.** The Apple Reminders
> provider uses AppleScript and only works on macOS. It is disabled by default.

### 3.2 Environment variable reference

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | HTTP port the server listens on. Default: `3500`. |
| `JWT_SECRET` | **Yes** | Secret used to sign JWT tokens. Must be long and random. |
| `DATABASE_URL` | **Yes** | MySQL connection string. Format: `mysql://user:pass@host:port/dbname`. |
| `ENCRYPTION_KEY` | **Yes** | 64-character hex string used for AES-256-GCM encryption of stored OAuth tokens. |
| `REDIS_URL` | No | Redis connection string. If omitted, all reads go directly to PostgreSQL. |
| `MICROSOFT_CLIENT_ID` | If using Microsoft | Azure App Registration client ID. |
| `MICROSOFT_CLIENT_SECRET` | If using Microsoft | Azure App Registration client secret. |
| `MICROSOFT_TENANT_ID` | If using Microsoft | Azure tenant ID (`common` for personal + work accounts; tenant GUID to restrict to one org). |
| `MICROSOFT_REDIRECT_URI` | If using Microsoft | Must match the URI registered in Azure exactly. |
| `GOOGLE_CLIENT_ID` | If using Google | Google OAuth 2.0 client ID. |
| `GOOGLE_CLIENT_SECRET` | If using Google | Google OAuth 2.0 client secret. |
| `GOOGLE_REDIRECT_URI` | If using Google | Must match the URI registered in Google Cloud exactly. |
| `DEFAULT_PROVIDER` | No | Default task provider for new users. Default: `microsoft`. |
| `ENABLE_APPLE_PROVIDER` | No | Set `true` only on macOS. Must be omitted or `false` on Linux. |

---

## 4. External Service Setup

### 4.1 Microsoft Azure — App Registration

1. Go to [portal.azure.com](https://portal.azure.com) > **Microsoft Entra ID** > **Manage** > **App registrations** > **New registration**. (Azure Active Directory was renamed to Microsoft Entra ID in 2023.)
2. Set **Name** to `Handsbreadth Task Server`.
3. Under **Redirect URI**, choose **Web** and enter:
   ```
   https://your-domain.com/auth/microsoft/callback
   ```
4. After registration, note the **Application (client) ID** and **Directory (tenant) ID**.
5. Go to **Manage** > **Certificates & secrets** > **New client secret**. Copy the **Value** immediately (not the Secret ID).
6. Go to **Manage** > **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated permissions**.
   Add: `Tasks.ReadWrite`, `offline_access`, `User.Read`. Click **Grant admin consent**.

Set in `.env`:
```ini
MICROSOFT_CLIENT_ID=<application-id>
MICROSOFT_CLIENT_SECRET=<client-secret-value>
MICROSOFT_TENANT_ID=<directory-tenant-id>
MICROSOFT_REDIRECT_URI=https://your-domain.com/auth/microsoft/callback
```

### 4.2 Google Cloud — OAuth 2.0 Credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com) > create or select a project.
2. Navigate to **APIs & Services** > **Library**. Search for **Google Tasks API** and enable it.
3. Go to **APIs & Services** > **Credentials** > **Create Credentials** > **OAuth client ID**.
4. Set **Application type** to **Web application**.
5. Under **Authorized redirect URIs**, add:
   ```
   https://your-domain.com/auth/google/callback
   ```
6. Download or copy the **Client ID** and **Client Secret**.
7. If the OAuth consent screen is in "Testing" mode, add user emails under **Test users**, or publish the app.

Set in `.env`:
```ini
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_REDIRECT_URI=https://your-domain.com/auth/google/callback
```

---

## 5. Start the Server

### Direct start (for testing only)

```bash
node src/server.js
```

### With PM2 (recommended for production)

Install PM2 globally:

```bash
npm install -g pm2
```

Start the server:

```bash
pm2 start src/server.js --name hb-task-server
```

Configure PM2 to start on system boot:

```bash
pm2 startup        # follow the printed command to install the startup hook
pm2 save           # persist the current process list
```

Useful PM2 commands:

```bash
pm2 status                    # show running processes
pm2 logs hb-task-server       # tail logs
pm2 restart hb-task-server    # restart after config changes
pm2 stop hb-task-server       # stop the server
```

---

## 6. Verification Scripts

Run these checks after deployment to confirm the server is operating correctly.
All commands target `https://your-domain.com`. Replace with `http://localhost:3500`
for local testing.

### 6.1 Health check

```bash
curl -s https://your-domain.com/health | jq .
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-03-03T12:00:00.000Z"
}
```

A non-200 status or connection error means the server is not running or the reverse proxy
is misconfigured.

### 6.2 Available providers

```bash
curl -s https://your-domain.com/api/providers | jq .
```

Expected response (Apple is disabled by default on a server deployment):
```json
{
  "providers": ["microsoft", "google"],
  "default": "microsoft"
}
```

If `ENABLE_APPLE_PROVIDER=true` is set, `"apple"` will appear first in the list.

### 6.3 User registration

```bash
curl -s -X POST https://your-domain.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "TestPass123!", "email": "test@example.com"}' \
  | jq .
```

Expected: `201` response with a `token` field. Save the token for subsequent tests:

```bash
TOKEN=$(curl -s -X POST https://your-domain.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "verify_'$(date +%s)'", "password": "TestPass123!", "email": "verify@example.com"}' \
  | jq -r '.token')

echo "Token: ${TOKEN:0:30}..."
```

### 6.4 Authenticated profile check

```bash
curl -s https://your-domain.com/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Expected: user object with `userId`, `username`, `email`.

### 6.5 Reject unauthenticated requests

```bash
curl -s -o /dev/null -w "%{http_code}" https://your-domain.com/api/lists
```

Expected output: `401`. Any other code is a security misconfiguration.

### 6.6 Login and token issuance

```bash
curl -s -X POST https://your-domain.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "TestPass123!"}' \
  | jq .
```

Expected: `200` with a `token` field.

### 6.7 Full multi-user smoke test

The repository includes a test script that registers two users, verifies isolation, and creates a task. Run it against the live server:

```bash
# Point the script at the deployed server (edit BASE_URL before running)
BASE_URL=https://your-domain.com node test-multiuser.js
```

All steps marked `✅` indicate a healthy deployment. Any `❌` requires investigation.

### 6.8 HTTPS and redirect URI validation

```bash
# Confirm TLS is valid
curl -sv https://your-domain.com/health 2>&1 | grep -E "SSL|TLS|certificate"

# Confirm HTTP redirects to HTTPS (if configured in reverse proxy)
curl -sv -o /dev/null http://your-domain.com/health 2>&1 | grep "Location:"
```

---

## 7. Enterprise Architecture Components

The application as shipped is a Node.js HTTP server. A production enterprise deployment requires
the following additional layers.

### 7.1 Reverse proxy with TLS — nginx + Certbot

Install nginx and obtain a Let's Encrypt certificate:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Example `/etc/nginx/sites-available/hb-task-server`:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Proxy all traffic to the Node.js server
    location / {
        proxy_pass         http://127.0.0.1:3500;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/hb-task-server /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

TLS certificate auto-renewal is installed by Certbot via a cron job or systemd timer.
Verify it with:

```bash
sudo certbot renew --dry-run
```

### 7.2 Process manager — PM2

Covered in [Section 5](#5-start-the-server). PM2 provides:

- Automatic restart on crash
- Startup on server reboot
- Log management (`pm2 logs`, `pm2 logrotate`)
- Cluster mode for multi-core scaling (requires stateless session storage first — see 7.3)

### 7.3 Database — MySQL (already implemented)

The application stores all data in MySQL with AES-256-GCM encrypted OAuth tokens. The schema is applied automatically on startup.

**Schema summary:**

| Table | Key columns |
|---|---|
| `users` | `user_id`, `username`, `email`, `password_hash`, `default_provider`, `show_completed` |
| `user_credentials` | `user_id`, `provider`, `access_token` (encrypted), `refresh_token` (encrypted), `updated_at` |

**Key security properties:**
- Passwords are hashed with bcrypt (10 rounds)
- OAuth access and refresh tokens are encrypted at rest with AES-256-GCM using `ENCRYPTION_KEY`
- Tokens are only decrypted in memory when needed for an API call

**For horizontal scaling:** add `REDIS_URL` to share the read cache across all instances. Without Redis, each instance reads from MySQL independently (correct but higher DB load).

**MySQL backups:**

```bash
# Daily logical backup
mysqldump -u hbtask -p hb_task_server | gzip > /backups/hb_task_server_$(date +%F).sql.gz

# Restore
gunzip -c /backups/hb_task_server_2026-03-05.sql.gz | mysql -u hbtask -p hb_task_server
```

For production, use a managed MySQL service with automatic backups (AWS RDS, Google Cloud SQL, Azure Database for MySQL) or configure binary log replication for point-in-time recovery.

### 7.4 Secrets management

Do not store `JWT_SECRET`, `MICROSOFT_CLIENT_SECRET`, or `GOOGLE_CLIENT_SECRET` in a `.env`
file on the server filesystem. Use a secrets manager:

| Platform | Service |
|---|---|
| AWS | AWS Secrets Manager or Parameter Store |
| GCP | Secret Manager |
| Azure | Azure Key Vault |
| Self-hosted | HashiCorp Vault |

Inject secrets as environment variables at runtime via the deployment system (systemd unit,
Docker, Kubernetes), not stored in files readable on disk.

### 7.5 Rate limiting

The server has no rate limiting. Add `express-rate-limit` to the application:

```bash
npm install express-rate-limit
```

Apply at minimum to authentication routes to prevent brute-force attacks:
- `POST /auth/login` — limit to ~10 requests per minute per IP
- `POST /auth/register` — limit to ~5 per hour per IP

### 7.6 Structured logging

`console.log` is not suitable for production. Replace with a structured logger:

```bash
npm install pino pino-pretty
```

Output logs as JSON for ingestion by a log aggregation system (Datadog, CloudWatch,
Elastic/Kibana, Loki). At minimum, log:
- All authentication events (login, register, failed attempts) with userId and IP
- All 4xx/5xx responses
- Provider credential storage and removal events

### 7.7 OAuth token refresh

**Current state:** Microsoft access tokens expire after ~1 hour. Google access tokens
expire after 1 hour. The server stores refresh tokens but never uses them to obtain new
access tokens. Users will get errors after their token expires.

**Required change:** Add token refresh logic to each provider:
- **Google:** Call `oauth2Client.refreshAccessToken()` when a request fails with 401,
  then retry and update the stored `accessToken`.
- **Microsoft:** Use `@azure/identity` `OnBehalfOfCredential` or re-initialize with a
  refreshed token.

### 7.8 Firewall

The Node.js server should not be directly reachable on port 3000 from the internet.
Only nginx (or your reverse proxy) should be publicly accessible.

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (redirects to HTTPS)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw deny 3500/tcp   # block direct Node.js access
sudo ufw enable
```

### 7.9 Monitoring and alerting

| Concern | Tool options |
|---|---|
| Uptime / health check | UptimeRobot, Pingdom, AWS Route 53 health checks |
| Application metrics | PM2 metrics, Datadog APM, New Relic |
| Error tracking | Sentry |
| Log aggregation | Datadog, CloudWatch Logs, Grafana Loki |

At minimum, configure an external monitor to ping `GET /health` every 60 seconds and
alert on failure.

### 7.10 Backup

Back up PostgreSQL using `pg_dump`:

```bash
# Example: daily backup to S3
mysqldump -u hbtask -p hb_task_server | gzip | aws s3 cp - s3://your-bucket/backups/hb_task_server_$(date +%F).sql.gz
```

For production, use a managed MySQL service with automated backups, or configure binary log replication with point-in-time recovery.

---

## 8. Known Limitations to Resolve Before Production

These are architectural gaps in the current codebase that must be addressed for a
production enterprise deployment.

| # | Limitation | Impact | Resolution |
|---|---|---|---|
| 1 | No OAuth token refresh | High — users get errors after provider token expires (~1 hour for Microsoft and Google) | Implement refresh logic in each provider: catch 401, call refresh endpoint, store new token, retry |
| 2 | No rate limiting | High — brute-force attack on `/auth/login` | Add `express-rate-limit` |
| 3 | No HTTPS enforcement in application | Medium — handled by reverse proxy, but must be enforced | Configure nginx to reject non-HTTPS; set `trust proxy` in Express |
| 4 | OAuth callback state is unsigned base64 | Medium — CSRF risk on the OAuth redirect | Sign the state parameter with a short-lived HMAC or use a server-side session |
| 5 | No password reset flow | Low — operational gap | Implement email-based reset |
| 6 | 30-day JWT expiry with no revocation | Low — stolen tokens valid up to 30 days | Reduce expiry or implement a token revocation list (e.g., store revoked JTIs in Redis) |
