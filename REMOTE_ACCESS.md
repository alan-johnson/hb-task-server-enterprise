# Remote Access Guide

This guide covers how to make the task server reachable outside your home or office network while keeping it protected from unauthorized access.

The server already uses JWT authentication (30-day tokens), bcrypt password hashing, and AES-256-GCM encrypted OAuth token storage. The options below address the network exposure layer.

---

## Option 1 — Tailscale (Recommended for personal/team use)

Tailscale creates a private mesh VPN. No ports are opened on your router, no firewall rules are needed, and it works through NAT automatically.

### Setup

```bash
# Install on the machine running hb-task-server
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Install the Tailscale app on each remote device (phone, laptop, etc.) and sign in with the same account. The server is then reachable at its Tailscale IP:

```
http://100.x.x.x:3500
```

### Notes

- Free for up to 3 users / 100 devices
- Zero open ports on your router
- Works through NAT and firewalls automatically
- Best for trusted teams where every user can install a VPN client

---

## Option 2 — Cloudflare Tunnel (Best for browser access, no VPN client needed)

Cloudflare Tunnel creates an outbound-only connection from your machine to Cloudflare's edge. No ports are opened, and HTTPS is handled automatically.

### Setup

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Authenticate (opens a browser window)
cloudflared tunnel login

# Create a named tunnel
cloudflared tunnel create hb-tasks

# Route a subdomain to the tunnel (requires a domain managed by Cloudflare)
cloudflared tunnel route dns hb-tasks tasks.yourdomain.com

# Run the tunnel
cloudflared tunnel run --url http://localhost:3500 hb-tasks
```

To run as a background service:

```bash
cloudflared service install
```

### Notes

- Free tier available; requires a domain you control (free to add to Cloudflare)
- Accessible from any browser at `https://tasks.yourdomain.com` — no client software needed
- Automatic HTTPS with Cloudflare's certificate
- Can add **Cloudflare Access** (also free for personal use) in front of the tunnel for an extra identity check (Google/GitHub SSO, one-time PIN) before the JWT login page is even shown

---

## Option 3 — nginx Reverse Proxy + HTTPS (If opening a port)

If you port-forward 443 from your router to the server machine, put nginx in front to terminate TLS. Never expose port 3500 directly to the internet.

### nginx config

```nginx
server {
    listen 443 ssl;
    server_name tasks.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/tasks.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tasks.yourdomain.com/privkey.pem;

    # Modern TLS only
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass         http://localhost:3500;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name tasks.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

### Free TLS certificate via Let's Encrypt

```bash
# Install certbot
brew install certbot  # macOS
# or: sudo apt install certbot python3-certbot-nginx  # Linux

# Obtain and auto-install certificate
sudo certbot --nginx -d tasks.yourdomain.com
```

Certbot adds an automatic renewal cron job. Certificates expire every 90 days and renew silently.

### Notes

- Requires a domain with a DNS A record pointing to your public IP
- Dynamic home IPs need a DDNS service (e.g., Cloudflare DDNS, DuckDNS) to keep the record current
- Firewall: allow only 80 and 443 inbound; block port 3500 from external access

---

## Option 4 — Deploy to a VPS

Run the server on a cloud VM instead of locally. This gives a stable IP and domain without depending on your home network uptime.

### Recommended providers

| Provider | Entry cost | Notes |
|---|---|---|
| Hetzner Cloud | ~$4/mo | Best value, EU-based |
| DigitalOcean | $6/mo | Simple UI, good docs |
| Fly.io | Free tier | Container-based, global edge |
| Oracle Cloud | Always Free tier | 2 VMs free forever (ARM) |

### Basic setup on a VPS

```bash
# 1. Install Node.js and PostgreSQL on the VM
# 2. Clone the repo and configure .env
# 3. Run behind nginx + certbot (see Option 3 above)
# 4. Use a process manager for reliability
npm install -g pm2
pm2 start src/server.js --name hb-task-server
pm2 save
pm2 startup
```

---

## Security Checklist

Regardless of which option you choose:

| Item | Why |
|---|---|
| Always use HTTPS | JWT tokens and passwords are readable in plain HTTP |
| Never expose port 3500 directly | No TLS, no rate limiting at the network layer |
| Use a strong `JWT_SECRET` (32+ random bytes) | Prevents token forgery |
| Use a strong `ENCRYPTION_KEY` (64 hex chars) | Protects stored OAuth tokens |
| Keep `DATABASE_URL` credentials out of version control | Never commit `.env` |
| Firewall: allow only 80/443 inbound | Block all other ports from the public internet |

### Generate secure secrets

```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Comparison

| Option | Open ports | Client required | Domain needed | Best for |
|---|---|---|---|---|
| Tailscale | None | Yes (VPN app) | No | Private teams |
| Cloudflare Tunnel | None | No | Yes | Public/browser access |
| nginx + HTTPS | 80, 443 | No | Yes | Self-hosted with own domain |
| VPS deployment | 80, 443 | No | Yes | Always-on, stable IP |
