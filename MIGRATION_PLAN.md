# Migration Plan: Namecheap → DigitalOcean

Two projects, one droplet:
- **Project A** — Move the UpQ task server to DO (Node + MySQL + Caddy)
- **Project B** — Move handsbreadth.com to the same droplet (PHP/static + Caddy)

Starting point: DO account exists, nothing else provisioned.
Completion: both sites live on DO, Namecheap Stellar plan cancelled.

> Tasks are ordered so each step's prerequisites are already done.
> Check off each box as you complete it.

---

## Phase 0 — Credentials & Tools (do this first, everything else depends on it)

- [ ] **Install `doctl`** (DO CLI) on your Mac:
  ```bash
  brew install doctl
  ```
- [ ] **Install Terraform** on your Mac:
  ```bash
  brew tap hashicorp/tap && brew install hashicorp/tap/terraform
  ```
- [ ] **Install `age`** (backup encryption tool):
  ```bash
  brew install age
  ```
- [ ] **Create a DO API token** with read+write scope:
  DO panel → API → Tokens → Generate New Token.
  Save it somewhere safe (1Password, etc.) — you will not see it again.
- [ ] **Create DO Spaces access keys**:
  DO panel → API → Spaces Keys → Generate New Key.
  Save the key ID and secret.
- [ ] **Authenticate `doctl`**:
  ```bash
  doctl auth init   # paste your DO API token when prompted
  ```
- [ ] **Generate an SSH key pair** for the `deploy` user (skip if you already have one you want to use):
  ```bash
  ssh-keygen -t ed25519 -C "deploy@upq" -f ~/.ssh/upq_deploy
  ```
- [ ] **Upload your SSH public key to DO**:
  DO panel → Settings → Security → Add SSH Key → paste `~/.ssh/upq_deploy.pub`.
  Note the key fingerprint shown (you need it for Terraform).
- [ ] **Generate an `age` keypair** for backup encryption:
  ```bash
  age-keygen -o ~/age-key.txt
  ```
  The file contains both public and private keys. Keep it OFF the server and out of git.
  The public key (starts with `age1...`) goes into `backup.env` later.
- [ ] **Set a DO billing alert**:
  DO panel → Billing → Alerts → set a threshold (e.g. $60/mo) so a misconfiguration
  can't silently run up a large bill.

---

## Phase 1 — Bootstrap Terraform Remote State (one-time manual step)

Terraform stores its state in a DO Spaces bucket. That bucket must exist before
`terraform init` — it cannot be created by Terraform itself (chicken-and-egg).

- [ ] **Create the Terraform state bucket by hand**:
  DO panel → Spaces Object Storage → Create Space:
  - Region: **NYC3**
  - Name: `upq-tfstate`
  - Access: **Private**
- [ ] **Export credentials** in your terminal before running Terraform:
  ```bash
  export DIGITALOCEAN_TOKEN=<your DO API token>
  export AWS_ACCESS_KEY_ID=<Spaces key ID>
  export AWS_SECRET_ACCESS_KEY=<Spaces secret>
  ```
  (These are session exports — add them to your shell profile or a `.envrc` if you prefer.)

---

## Phase 2 — Configure Terraform

- [ ] **Put your SSH public key into cloud-init**:
  Edit `upq_terraform_files/upq-infra/cloud-init/app.yaml`.
  Replace `ssh-ed25519 AAAA_REPLACE_WITH_YOUR_PUBLIC_KEY deploy@upq`
  with the actual contents of `~/.ssh/upq_deploy.pub`.

- [ ] **Create `terraform.tfvars`** from the example:
  ```bash
  cd upq_terraform_files/upq-infra/terraform
  cp terraform.tfvars.example terraform.tfvars
  ```
  Fill in:
  - `ssh_key_fingerprint` — from `doctl compute ssh-key list`
  - `ssh_allowed_cidrs` — your home/office IP: `["YOUR.IP.ADDR/32"]`
    Find your IP: `curl ifconfig.me`
  - `spaces_access_id` and `spaces_secret_key` — from Phase 0
  - Leave `domain = ""` (we manage DNS at Namecheap manually, not through Terraform)

- [ ] **Verify `terraform.tfvars` is gitignored** — it contains secrets.
  Check `upq_terraform_files/upq-infra/.gitignore` includes `terraform.tfvars`.

---

## Phase 3 — Provision Infrastructure

- [ ] **Initialize Terraform**:
  ```bash
  cd upq_terraform_files/upq-infra/terraform
  terraform init
  ```
- [ ] **Review the plan** — read every resource carefully:
  ```bash
  terraform plan
  ```
- [ ] **Apply** (creates droplet, managed MySQL, VPC, firewall, Spaces backup bucket):
  ```bash
  terraform apply
  ```
  This takes 5–10 minutes. The managed MySQL cluster takes the longest.
- [ ] **Save the outputs** — you need these throughout the rest of setup:
  ```bash
  terraform output app_ipv4              # droplet public IP
  terraform output -raw db_private_host  # DB hostname (VPC-internal)
  terraform output db_port               # 25060
  terraform output db_name               # upq
  terraform output db_app_user           # upq_app
  terraform output -raw db_app_password  # DB password
  ```
  Store these in 1Password or a local encrypted note — not in git.

---

## Phase 4 — First Boot: Place Files on the Droplet

Wait ~5 minutes after `terraform apply` for cloud-init to finish installing Node,
Caddy, PHP-FPM, and Flyway before SSHing in.

- [ ] **SSH in as `deploy`**:
  ```bash
  ssh -i ~/.ssh/upq_deploy deploy@<app_ipv4>
  ```
- [ ] **Confirm cloud-init finished**:
  ```bash
  sudo cloud-init status --wait
  # Should print: status: done
  ```
- [ ] **Create the app directory and clone the UpQ repo**:
  ```bash
  mkdir -p /home/deploy/upq
  git clone https://github.com/alan-johnson/hb-task-server-enterprise.git /home/deploy/upq
  ```
- [ ] **Create the UpQ `.env` file** on the droplet:
  ```bash
  nano /home/deploy/upq/.env
  # chmod 600 /home/deploy/upq/.env after saving
  ```
  Fill in every variable from `.env.example`. Key production values:
  - `PORT=3500`
  - `WEB_URL=https://tasks.handsbreadth.com`
  - `ALLOWED_ORIGIN=https://tasks.handsbreadth.com`
  - `DATABASE_URL=mysql://upq_app:<db_app_password>@<db_private_host>:25060/upq`
  - `DB_SSL_CA_PATH=/home/deploy/ca-certificate.crt`
  - `JWT_SECRET=` — generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  - `ENCRYPTION_KEY=` — generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_ANNUAL`
  - `SMTP_HOST=mail.privateemail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`
  - `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
  - `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI=https://tasks.handsbreadth.com/auth/microsoft/callback`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://tasks.handsbreadth.com/auth/google/callback`
  - `REDIS_URL=` — leave commented out (Redis not used at launch)

- [ ] **Download the DO MySQL CA certificate**:
  DO panel → Databases → your MySQL cluster → "Download CA certificate".
  Copy it to the droplet:
  ```bash
  scp -i ~/.ssh/upq_deploy ~/Downloads/ca-certificate.crt deploy@<app_ipv4>:/home/deploy/ca-certificate.crt
  chmod 600 /home/deploy/ca-certificate.crt
  ```

- [ ] **Place the Caddyfile**:
  ```bash
  sudo cp /home/deploy/upq/upq_terraform_files/upq-infra/scripts/Caddyfile /etc/caddy/Caddyfile
  sudo systemctl reload caddy
  ```

- [ ] **Place the ecosystem.config.js** (PM2 process config):
  ```bash
  cp /home/deploy/upq/upq_terraform_files/upq-infra/ecosystem.config.js /home/deploy/upq/ecosystem.config.js
  ```

- [ ] **Install Node dependencies**:
  ```bash
  cd /home/deploy/upq && npm ci --omit=dev
  ```

- [ ] **Set up backup secrets**:
  ```bash
  sudo mkdir -p /etc/upq
  sudo nano /etc/upq/backup.env
  sudo chmod 600 /etc/upq/backup.env
  ```
  Fill in: `DB_HOST`, `DB_PORT=25060`, `DB_NAME=upq`, `DB_USER`, `DB_PASS`,
  `AGE_RECIPIENT=<your age public key from ~/age-key.txt>`,
  `SPACES_BUCKET=upq-backups`, `SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com`,
  `B2_BUCKET=<your Backblaze bucket name>`

- [ ] **Place backup script and add cron**:
  ```bash
  cp /home/deploy/upq/upq_terraform_files/upq-infra/scripts/backup.sh /home/deploy/backup.sh
  chmod +x /home/deploy/backup.sh
  crontab -e
  # Add: 0 3 * * * /home/deploy/backup.sh >> /var/log/upq-backup.log 2>&1
  ```

---

## Phase 5 — Backblaze B2 Setup (off-site backup copy)

- [ ] **Create a Backblaze account** at backblaze.com if you don't have one.
- [ ] **Create a B2 bucket**: name it `upq-backups-b2`, private.
- [ ] **Create B2 application keys** with write access to that bucket.
- [ ] **Install `rclone`** on the droplet:
  ```bash
  sudo apt-get install -y rclone
  rclone config   # add a remote named 'b2' using your B2 keys
  ```

---

## Phase 6 — Configure GitHub Actions CI/CD

- [ ] **Add GitHub Actions secrets** to the `hb-task-server-enterprise` repo:
  GitHub → repo → Settings → Secrets and variables → Actions → New repository secret:
  - `SSH_HOST` — droplet public IP
  - `SSH_PRIVATE_KEY` — contents of `~/.ssh/upq_deploy` (the private key)
  - `FLYWAY_URL` — `jdbc:mysql://<db_private_host>:25060/upq?sslMode=REQUIRED`
  - `FLYWAY_USER` — `upq_app`
  - `FLYWAY_PASSWORD` — DB app password from `terraform output`

- [ ] **Commit and push the workflow file** (already moved to `.github/workflows/deploy.yml`):
  ```bash
  git add .github/workflows/deploy.yml
  git commit -m "add deploy workflow"
  git push
  ```

---

## Phase 7 — Register OAuth Redirect URIs for Production

The Microsoft and Google OAuth apps need the production callback URLs added before
login will work on the new hostname.

- [ ] **Microsoft** — Azure portal → App registrations → your UpQ app →
  Authentication → add redirect URI:
  `https://tasks.handsbreadth.com/auth/microsoft/callback`

- [ ] **Google** — Google Cloud Console → Credentials → your OAuth 2.0 client →
  Authorized redirect URIs → add:
  `https://tasks.handsbreadth.com/auth/google/callback`

---

## Phase 8 — Stripe Production Webhook

- [ ] **Register the webhook** in the Stripe Dashboard (live mode):
  Stripe → Developers → Webhooks → Add endpoint:
  - URL: `https://tasks.handsbreadth.com/webhook`
  - Events: `customer.subscription.updated`, `customer.subscription.deleted`,
    `invoice.payment_failed` (add any others the app handles)
- [ ] **Copy the webhook signing secret** and add it to the droplet `.env`:
  `STRIPE_WEBHOOK_SECRET=whsec_...`
- [ ] **Restart the app** after updating `.env`:
  ```bash
  pm2 reload upq --update-env
  ```

---

## Phase 9 — Smoke Test on the Droplet IP (before DNS cutover)

Test directly against the droplet IP before touching DNS, so the live Namecheap
site is unaffected if anything is wrong.

- [ ] **Start the app with PM2**:
  ```bash
  cd /home/deploy/upq
  pm2 start ecosystem.config.js
  pm2 save
  ```
- [ ] **Check the app is running**:
  ```bash
  pm2 status
  curl http://localhost:3500/health   # or whatever health endpoint the app exposes
  ```
- [ ] **Test DB connectivity** — confirm the app logs show "connected to MySQL" on startup.
- [ ] **Test the app via IP** (HTTP only at this stage — Caddy needs the real domain for HTTPS):
  `http://<app_ipv4>` — you should see the UpQ app or a redirect.
- [ ] **Trigger a manual test deploy** — push a trivial commit to `main` and confirm
  the GitHub Actions deploy workflow succeeds end-to-end.
- [ ] **Run a test backup**:
  ```bash
  /home/deploy/backup.sh
  # Confirm the encrypted file appears in DO Spaces and B2
  ```

---

## Phase 10 — DNS Cutover for tasks.handsbreadth.com (Project A goes live)

Only do this after Phase 9 is fully green.

- [ ] **Lower the TTL** on `tasks.handsbreadth.com` at Namecheap to 300 seconds.
  Wait for the current TTL to expire before proceeding.
- [ ] **Update the DNS A record** at Namecheap:
  Advanced DNS → find (or add) the `tasks` A record → change value to the droplet IP.
- [ ] **Wait for DNS propagation** (a few minutes at TTL 300).
  Verify: `dig tasks.handsbreadth.com` should return the droplet IP.
- [ ] **Confirm Caddy got a cert**: `https://tasks.handsbreadth.com` should load with
  a valid Let's Encrypt certificate (green padlock).
- [ ] **Test login, task sync, WebSocket bridge** — the full golden path.
- [ ] **Raise the TTL** back to 3600 once confirmed stable.

---

## Phase 11 — Migrate handsbreadth.com (Project B)

- [ ] **Clone the handsbreadth.com site repo** on the droplet:
  ```bash
  git clone https://github.com/<your-org>/handsbreadth-site.git /var/www/handsbreadth
  ```
- [ ] **Place the site's `.env` file** (not in git):
  ```bash
  nano /var/www/handsbreadth/.env
  chmod 600 /var/www/handsbreadth/.env
  ```
  Contents:
  ```
  RECAPTCHA_SECRET_KEY=...
  EMAIL_USERNAME=...
  EMAIL_PASSWORD=...
  ```
- [ ] **Verify PHP-FPM is running**:
  ```bash
  systemctl status php8.3-fpm
  curl http://localhost/   # should serve the site (HTTP only before DNS)
  ```
- [ ] **Lower TTL** for `handsbreadth.com` and `www.handsbreadth.com` at Namecheap to 300.
  Wait for current TTL to expire.
- [ ] **Update DNS A records** at Namecheap:
  - `@` (apex) A record → droplet IP
  - `www` A record → droplet IP
- [ ] **Wait for propagation**, then verify: `https://www.handsbreadth.com` loads with
  a valid cert and the contact form works end-to-end (sends a real test email).
- [ ] **Raise TTLs** back to 3600 once confirmed stable.

---

## Phase 12 — Cancel Namecheap Stellar (final step)

Do not cancel until both DNS cutovers are confirmed working and stable for at least
24 hours.

- [ ] **Confirm both sites are fully working on DO** for 24+ hours.
- [ ] **Export/download anything you want to keep** from Namecheap hosting
  (email archives, old files, MySQL databases if any — anything not already in git).
- [ ] **Cancel the Stellar hosting plan** at Namecheap:
  Namecheap → Dashboard → your Stellar plan → Cancel.
- [ ] **Do NOT cancel domain registration** — `handsbreadth.com` must stay registered.

---

## Ongoing After Launch

- [ ] **Monthly restore test**: decrypt a backup dump and restore into a throwaway DB.
  Instructions are in `upq_terraform_files/upq-infra/scripts/backup.sh`.
- [ ] **Check DO billing alert** is still configured and set to a sensible threshold.
- [ ] **Renew domain registration** annually at Namecheap (~$13/yr).

---

## Summary of Final Monthly Costs

| Item | Cost |
|---|---|
| Namecheap domain registration | ~$1/mo (~$13/yr) |
| DO Droplet (s-1vcpu-2gb) | $18/mo |
| DO Managed MySQL (db-s-1vcpu-1gb) | $15/mo |
| DO Spaces (state + backups) | $5/mo |
| Backblaze B2 (off-site backup) | $1–3/mo |
| **Total** | **~$40–42/mo** |
