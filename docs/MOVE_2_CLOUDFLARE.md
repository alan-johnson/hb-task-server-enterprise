# Cloudflare Migration Plan — UpQ Enterprise Server

---

## Estimated Operating Costs at 5,000 MAU

### Usage Assumptions

| Metric | Estimate | Basis |
|---|---|---|
| Monthly active users | 5,000 | Given |
| Sessions per user/week | ~3 | Typical task app usage |
| API requests per session | ~30 | Page loads + task fetches + actions |
| **Total API requests/month** | **~2M** | 5,000 × 3 × 4.3wks × 30 |
| Avg API response size | ~5 KB | JSON lists/tasks |
| Static asset bandwidth | ~2 GB | Cached at Cloudflare edge after first hit |
| Origin bandwidth (VPS) | ~10 GB | API responses only; statics served by CF |
| Persistent WS connections (bridge) | ~50–150 peak | Subset of users using Apple Reminders |
| Emails/month | ~7,000 | Signups, verifications, password resets |

---

### 1. VPS / Compute

The Node.js server + MySQL on a single VPS handles 5,000 MAU comfortably. MySQL at this scale uses ~300–500 MB RAM; Node.js uses ~150–300 MB. A 2 vCPU / 4 GB RAM instance has substantial headroom.

| Provider | Spec | Monthly |
|---|---|---|
| **Hetzner CX22** | 2 vCPU, 4 GB RAM, 40 GB SSD | **~$6** |
| Hetzner CAX21 (ARM) | 2 vCPU ARM, 4 GB RAM | ~$5 |
| DigitalOcean | 2 vCPU, 4 GB RAM | $24 |
| Vultr | 2 vCPU, 4 GB RAM | $20 |
| Linode/Akamai | 2 vCPU, 4 GB RAM | $18 |

**Recommendation: Hetzner CX22 (~$6/month).** Same reliability as DO/Vultr at a fraction of the cost. Located in Ashburn (US East), Hillsboro (US West), or Helsinki/Nuremberg (EU).

---

### 2. Cloudflare

| Tier | What you get | Monthly |
|---|---|---|
| **Free** | Tunnel, CDN, basic WAF, DNS, DDoS, analytics | **$0** |
| Pro | Better WAF rules, rate limiting, image optimization | $20 |

**Free tier covers all core needs at 5,000 MAU.** The main reason to upgrade to Pro is rate limiting on `/auth/login` and `/auth/register` to prevent credential stuffing — worth it once you have paying users.

Cloudflare's free CDN will serve your static assets (HTML, CSS, JS, images) from edge nodes globally, meaning essentially zero bandwidth cost to the VPS for those files.

---

### 3. Database

**Option A — MySQL on same VPS: $0 additional**
Already included in VPS cost. Perfectly sufficient at 5,000 MAU. Schedule daily `mysqldump` backups to a cheap object store.

**Option B — Managed MySQL (if you want separation of concerns)**

| Provider | Spec | Monthly |
|---|---|---|
| DigitalOcean Managed MySQL | 1 vCPU, 1 GB RAM | $15 |
| PlanetScale | Scaler plan | $39 |
| Aiven MySQL | 1 vCPU, 1 GB | ~$19 |

Managed MySQL adds automatic backups, failover, and no ops burden. Not necessary at 5,000 MAU but worth it if the data is business-critical.

---

### 4. Backups

| Option | Details | Monthly |
|---|---|---|
| **Local cron + rotation** | Daily gzip dumps, keep 30 days, stored on VPS disk | **$0** |
| Backblaze B2 | Offsite backup, 10 GB free then $0.006/GB | ~$0–1 |
| Cloudflare R2 | 10 GB free, zero egress fees | **$0** |
| DigitalOcean Spaces | 250 GB + 1 TB transfer | $5 |

**Recommendation: daily cron + Cloudflare R2 for offsite copies.** R2's free tier (10 GB) is more than enough for compressed MySQL dumps at this scale, and there are no egress fees.

---

### 5. Email / SMTP

5,000 MAU generates roughly:
- ~5,000 verification emails (new signups)
- ~500 password reset emails
- ~1,500 other transactional (welcome, billing confirmations)
- **~7,000 emails/month**

| Provider | Free tier | Cost at 7K/month |
|---|---|---|
| **Resend** | 3,000/month | **$20** (Starter plan: 50K/month) |
| Postmark | 100/month | $15 (10K messages plan) |
| Mailgun | 1,000/day for 3 months | $35 (Foundation plan) |
| AWS SES | 62K/month (from EC2) | ~$0.70 |
| Brevo (Sendinblue) | 300/day (9K/month) | **$0** (free tier covers it) |

**Recommendation: Brevo free tier** (9,000 emails/month free) or **Resend** ($20/month for better deliverability and developer experience).

---

### 6. Stripe Processing Fees

Stripe charges **2.9% + $0.30 per successful transaction** (US cards). This is a revenue-dependent variable cost, not a fixed infrastructure cost.

Example impact at different subscription price points:

| Plan Price | Stripe Fee/Transaction | Net to You |
|---|---|---|
| $4.99/month | $0.44 (8.9%) | $4.55 |
| $7.99/month | $0.53 (6.7%) | $7.46 |
| $9.99/month | $0.59 (5.9%) | $9.40 |
| $49.99/year | $1.75 (3.5%) | $48.24 |
| $79.99/year | $2.62 (3.3%) | $77.37 |

Annual plans are significantly more efficient — the fixed $0.30 is amortized over 12 months vs. charged monthly.

If **20% of 5,000 users** (1,000) are paying subscribers at $7.99/month: Stripe fees = ~$530/month.

---

### 7. Monitoring

| Tool | Cost | Notes |
|---|---|---|
| **UptimeRobot** | **$0** | 5-minute checks, email alerts, free forever |
| Better Uptime | $0 | Free tier with SMS alerts |
| Cloudflare Health Checks | Included in Pro ($20) | |

---

### Total Monthly Cost Summary

**Minimum (Hetzner + Cloudflare Free + local MySQL + Brevo free)**

| Item | Monthly |
|---|---|
| Hetzner CX22 VPS | $6 |
| Cloudflare | $0 |
| MySQL (on VPS) | $0 |
| Email (Brevo free) | $0 |
| Backups (R2 free tier) | $0 |
| Monitoring (UptimeRobot) | $0 |
| **Total infrastructure** | **~$6/month** |
| Stripe fees (variable) | 2.9% + $0.30/txn |

**Recommended production setup (Hetzner + Cloudflare Pro + local MySQL + Resend)**

| Item | Monthly |
|---|---|
| Hetzner CX22 VPS | $6 |
| Cloudflare Pro | $20 |
| MySQL (on VPS) | $0 |
| Email (Resend) | $20 |
| Backups (Cloudflare R2) | $0 |
| Monitoring (UptimeRobot) | $0 |
| **Total infrastructure** | **~$46/month** |
| Stripe fees (variable) | 2.9% + $0.30/txn |

**DigitalOcean equivalent (if you prefer DO ecosystem)**

| Item | Monthly |
|---|---|
| DO Droplet 2 vCPU 4 GB | $24 |
| Cloudflare Pro | $20 |
| DO Managed MySQL | $15 |
| Email (Postmark) | $15 |
| DO Spaces (backups) | $5 |
| Monitoring | $0 |
| **Total infrastructure** | **~$79/month** |

---

### Scaling Threshold

At 5,000 MAU the single-VPS setup has headroom to grow. You'd typically need to reconsider the architecture at:

- **~15,000–20,000 MAU**: Consider adding Redis for caching (reduces MySQL load), upgrade VPS to 4 vCPU / 8 GB
- **~50,000+ MAU**: Consider load balancing, separate MySQL host, Redis cluster

At 5,000 MAU the **~$46/month** recommended setup runs comfortably with room to double in traffic before needing any changes.

---

## Architecture Overview

```
Internet → Cloudflare (DNS, SSL, CDN, WAF)
               ↓
         Cloudflare Tunnel (cloudflared daemon)
               ↓
         VPS / Cloud VM
          ├─ Node.js task-server.js (port 3500)
          │    └─ WebSocket bridge (/bridge)
          └─ MySQL 8+ (local or managed)
```

Cloudflare handles: SSL termination, DDoS, WAF, CDN for static assets, DNS.
Your VPS handles: Node.js runtime, WebSocket connections, MySQL.

The hybrid model is recommended over a full Workers rewrite. Full Workers migration
would require rewriting the Express server in the Workers runtime and using Durable
Objects for the stateful WebSocket bridge — a significant effort with no functional benefit.

---

## Phase 1 — Provision the VPS

**1.1 Choose a provider**
- DigitalOcean, Hetzner, Vultr, or Linode — any works. Hetzner is cheapest per spec.
- Minimum spec: 1 vCPU, 1 GB RAM, 25 GB SSD (2 GB RAM recommended for MySQL on same box)
- Ubuntu 22.04 LTS

**1.2 Initial server hardening**
```bash
# Create a non-root deploy user
adduser deploy
usermod -aG sudo deploy

# Disable root SSH login
sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd

# Firewall — only allow SSH. Cloudflare Tunnel handles HTTP/HTTPS.
ufw allow OpenSSH
ufw enable
# Do NOT open port 80, 443, or 3500 publicly — Tunnel handles this.
```

**1.3 Install Node.js 20 LTS**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential
```

---

## Phase 2 — MySQL Database

**Option A: Local MySQL on the same VPS (simpler)**
```bash
sudo apt install -y mysql-server
sudo mysql_secure_installation
mysql -u root -p
```
```sql
CREATE DATABASE upq_enterprise;
CREATE USER 'upquser'@'localhost' IDENTIFIED BY 'strong-password';
GRANT ALL PRIVILEGES ON upq_enterprise.* TO 'upquser'@'localhost';
FLUSH PRIVILEGES;
```
`DATABASE_URL=mysql://upquser:strong-password@localhost:3306/upq_enterprise`

**Option B: PlanetScale (managed MySQL, free tier available)**
- Create a database at planetscale.com
- Use their connection string in `DATABASE_URL`
- Benefit: automatic backups, branching, scales independently of VPS
- Note: PlanetScale uses connection strings with TLS — ensure MySQL2 is configured with `ssl: { rejectUnauthorized: true }`

**Schema initialization**
```bash
# The server auto-applies schema.sql on first boot, so just start the server once.
# Or manually apply:
mysql -u upquser -p upq_enterprise < src/db/schema.sql
```

**Database backups (critical)**
```bash
# Add to crontab: daily mysqldump at 2am
0 2 * * * mysqldump -u upquser -pPASSWORD upq_enterprise | gzip > /backups/upq-$(date +\%Y\%m\%d).sql.gz
# Keep 30 days
find /backups -name "*.sql.gz" -mtime +30 -delete
```

---

## Phase 3 — Deploy the Node.js Server

**3.1 Clone and configure**
```bash
sudo -u deploy bash
cd /home/deploy
git clone <your-repo-url> upq-server
cd upq-server
npm install --production
```

**3.2 Create the `.env` file**
```bash
nano .env
```
```env
PORT=3500
WEB_URL=https://your-domain.com

# Security
JWT_SECRET=<64-char random hex>
ENCRYPTION_KEY=<64-char random hex>

# Database
DATABASE_URL=mysql://upquser:password@localhost:3306/upq_enterprise

# Email
SMTP_HOST=smtp.mailgun.org       # or Postmark, SES, Resend
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=UpQ <noreply@your-domain.com>

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID_MONTHLY=price_...
STRIPE_PRICE_ID_ANNUAL=price_...
STRIPE_TRIAL_DAYS=14

# Google Tasks OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-domain.com/auth/google/callback

# Microsoft Tasks OAuth
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=https://your-domain.com/auth/microsoft/callback

# CORS
ALLOWED_ORIGIN=https://your-domain.com
```

**3.3 Run as a managed process with PM2**
```bash
sudo npm install -g pm2

pm2 start src/task-server.js --name upq-server
pm2 save
pm2 startup   # follow the printed command to enable auto-restart on reboot
```

Useful PM2 commands:
```bash
pm2 logs upq-server        # tail logs
pm2 restart upq-server     # after .env changes
pm2 monit                  # live process monitor
```

---

## Phase 4 — Cloudflare DNS and Tunnel (replaces web-server.js + SSL)

Cloudflare Tunnel creates an outbound-only encrypted connection from your VPS to
Cloudflare's edge — no inbound ports needed on the VPS.

**4.1 Add your domain to Cloudflare**
1. Log in to dash.cloudflare.com → Add a Site → enter your domain
2. Choose the Free plan (sufficient for this)
3. Cloudflare will scan your existing DNS records
4. Update your domain registrar's nameservers to the two Cloudflare nameservers shown
5. Wait for propagation (usually < 30 minutes)

**4.2 Install cloudflared on the VPS**
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

**4.3 Authenticate cloudflared to your Cloudflare account**
```bash
cloudflared tunnel login
# Opens a browser URL — complete the auth flow and select your domain
```

**4.4 Create the tunnel**
```bash
cloudflared tunnel create upq-production
# Note the tunnel ID printed — you'll need it
```

**4.5 Configure the tunnel**
```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```
```yaml
tunnel: <tunnel-id-from-above>
credentials-file: /home/deploy/.cloudflared/<tunnel-id>.json

ingress:
  # Main app — HTTP and WebSocket traffic
  - hostname: your-domain.com
    service: http://localhost:3500
  # Catch-all required by cloudflared
  - service: http_status:404
```
Cloudflare Tunnel transparently proxies WebSocket upgrade requests, so the `/bridge`
WebSocket endpoint works without any special configuration.

**4.6 Create a DNS CNAME record pointing to the tunnel**
```bash
cloudflared tunnel route dns upq-production your-domain.com
# This creates: your-domain.com → <tunnel-id>.cfargotunnel.com
```

**4.7 Run cloudflared as a system service**
```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

**4.8 SSL/HTTPS — automatic via Cloudflare**
No certificate management needed. Cloudflare issues and auto-renews a TLS certificate
for your domain and terminates HTTPS at the edge.

- Cloudflare dashboard → SSL/TLS → set mode to **Full (strict)**

Optionally install a Cloudflare Origin Certificate on the VPS for the tunnel leg:
- Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate
- Save the cert and key to the VPS and configure cloudflared to use HTTPS to origin

---

## Phase 5 — Static Files / Public Web Pages

The Node.js server already serves `src/public/` via `express.static`. Under Cloudflare,
static assets (HTML, CSS, JS, images) will be automatically cached at Cloudflare's edge
after the first request.

**5.1 Enable Cloudflare caching for static assets**

In Cloudflare dashboard → Caching → Cache Rules, add a rule:
- Match: `(http.request.uri.path matches "\\.(css|js|png|jpg|ico|webmanifest)$")`
- Action: Cache, Edge TTL 1 day, Browser TTL 1 hour

**5.2 Optional: Cloudflare Pages for static files (advanced)**

If you want to fully offload static serving from the VPS:
- Copy `src/public/` as the build output directory
- Connect a GitHub repo to Cloudflare Pages
- Add a `_routes.json` to proxy `/api/*`, `/auth/*`, `/billing/*` to the tunnel
- Benefit: static files served from edge with zero VPS involvement

This is optional — the current setup works fine without it.

---

## Phase 6 — Stripe Integration

**6.1 Update the Stripe webhook endpoint**

In the Stripe dashboard → Developers → Webhooks:
- Remove any old webhook endpoints
- Add: `https://your-domain.com/billing/webhook`
- Events to listen for:
  - `checkout.session.completed`
  - `customer.subscription.deleted`
  - `customer.subscription.updated` (recommended addition)
- Copy the new **Signing Secret** → update `STRIPE_WEBHOOK_SECRET` in `.env`
- Restart PM2: `pm2 restart upq-server`

**6.2 Prevent Cloudflare WAF from blocking Stripe**

Cloudflare's WAF can block Stripe's webhook delivery. Add an exception:
- Cloudflare dashboard → Security → WAF → Tools
- Add a WAF skip rule matching Stripe's published IP ranges, skip all WAF checks
- Or: WAF → Managed Rules → create an exception for the path `/billing/webhook`

**6.3 Update Stripe redirect URLs**

In your checkout session creation code, confirm `success_url` and `cancel_url`
use the production domain (`https://your-domain.com/success.html`, etc.).

---

## Phase 7 — OAuth Provider Configuration

**7.1 Google Tasks OAuth**
- Google Cloud Console → your project → Credentials → OAuth 2.0 Client
- Add to **Authorized redirect URIs**: `https://your-domain.com/auth/google/callback`
- Update `GOOGLE_REDIRECT_URI` in `.env`

**7.2 Microsoft Graph OAuth**
- Azure Portal → App registrations → your app → Authentication
- Add to **Redirect URIs**: `https://your-domain.com/auth/microsoft/callback`
- Update `MICROSOFT_REDIRECT_URI` in `.env`

---

## Phase 8 — Email / SMTP

The built-in Nodemailer setup works as-is. Recommended providers for production:

| Provider     | Free tier          | Notes                              |
|--------------|--------------------|------------------------------------|
| **Resend**   | 3,000/month        | Best developer experience          |
| **Postmark** | 100/month free     | Best deliverability                |
| **Mailgun**  | 1,000/day (3 mo.)  | Good for transactional             |
| **AWS SES**  | 62,000/month       | Cheapest at scale                  |

Update the `SMTP_*` env vars in `.env` for whichever provider you choose.
All work with Nodemailer's SMTP transport without code changes.

---

## Phase 9 — Apple Reminders Bridge (WebSocket)

The bridge server runs on the same port as the API (`/bridge` path). Cloudflare Tunnel
handles WebSocket upgrades transparently.

Update the local hb-task-server (Mac app) configuration to connect to:
```
wss://your-domain.com/bridge
```
instead of a local address. No server-side changes are needed.

---

## Phase 10 — Cloudflare Security Configuration

**10.1 WAF rules**
- Enable **Cloudflare Managed Ruleset** (free tier includes basic protection)
- Enable **Bot Fight Mode**

**10.2 Rate limiting (paid add-on, recommended)**
- `/auth/login`: 10 requests/minute per IP
- `/auth/register`: 5 requests/minute per IP
- `/billing/*`: 20 requests/minute per IP

**10.3 Confirm no direct VPS access**
All traffic routes through the tunnel. Verify no ports are publicly exposed:
```bash
sudo ufw status
# Expected: only OpenSSH (22) allowed
```

**10.4 Enable HSTS**
- Cloudflare dashboard → SSL/TLS → Edge Certificates → Enable HSTS
- Max-age: 6 months, include subdomains

---

## Phase 11 — Monitoring and Logging

**11.1 PM2 log rotation**
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 30
```

**11.2 Uptime monitoring**
- **UptimeRobot** (free): checks every 5 minutes, email alerts on downtime
- Monitor the health endpoint: `https://your-domain.com/health`
- Cloudflare Health Checks also available on paid plans

**11.3 Cloudflare Analytics**
The Cloudflare dashboard provides request counts, bandwidth, threats blocked, and
error rates at no cost — useful baseline metrics without any instrumentation.

---

## What You Don't Need

- **web-server.js** — the Cloudflare Tunnel replaces it entirely; no separate web server for static files or proxying
- **Let's Encrypt / Certbot** — Cloudflare manages certificates at the edge
- **nginx** — the tunnel sends traffic directly to Node.js on port 3500
- **Redis** — only needed for multi-instance deployments; a single VPS works fine without it

---

## Checklist

```
[ ] VPS provisioned and hardened (non-root user, SSH only via UFW)
[ ] Node.js 20 + PM2 installed
[ ] MySQL installed and schema applied
[ ] .env configured with all production values
[ ] App running under PM2 with startup hook enabled
[ ] Domain added to Cloudflare, nameservers updated at registrar
[ ] cloudflared installed and tunnel created
[ ] DNS CNAME pointing to tunnel
[ ] SSL/TLS mode set to Full (strict)
[ ] Cloudflare caching rules set for static assets
[ ] Stripe webhook endpoint updated to production URL
[ ] Stripe WAF exception added for /billing/webhook
[ ] Google OAuth redirect URI updated in Google Cloud Console
[ ] Microsoft OAuth redirect URI updated in Azure Portal
[ ] SMTP provider configured and verified
[ ] PM2 log rotation enabled
[ ] UptimeRobot monitoring /health endpoint
[ ] Daily database backups scheduled via cron
[ ] UFW confirmed: only SSH port open
```
