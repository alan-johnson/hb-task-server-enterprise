# UpQ Infrastructure

Infrastructure-as-code for UpQ: a single DigitalOcean droplet (Node + Caddy)
fronting a managed MySQL cluster, with Terraform provisioning, GitHub Actions
CI/CD, Flyway raw-SQL migrations, and 3-2-1 encrypted backups.

Region: **NYC3** (closest to Chicago). Engine: **MySQL 8** (managed).

## What's here

```
terraform/        Infra definition (droplet, VPC, managed MySQL, firewall, Spaces, DNS)
cloud-init/       First-boot hardening (non-root user, SSH lockdown, ufw, fail2ban,
                  Node 22, Caddy, Flyway, auto-updates)
scripts/          Caddyfile (auto-HTTPS reverse proxy) + backup.sh (3-2-1, encrypted)
migrations/       Flyway raw-SQL migrations (V1__*.sql, V2__*.sql, ...)
.github/workflows/ terraform.yml (infra) + deploy.yml (app code + DB migrate)
```

## Monthly cost (launch config)

| Item | ~Cost |
|---|---|
| Droplet (s-1vcpu-2gb) | $18 |
| Managed MySQL (db-s-1vcpu-1gb, single node) | $15 |
| Spaces (state + backup mirror) | $5 |
| Backblaze B2 (off-site copy) | $1–3 |
| **Total** | **~$39–41** |

Later opt-in upgrades: DB standby node (HA, ~+$15), Load Balancer (~+$12).
**Set a DO billing alert immediately** (Billing > Alerts).

## Setup order (first time)

There's a chicken-and-egg with remote state: Terraform stores its state in a
Spaces bucket, but it can't create state in a bucket that doesn't exist yet.
So bootstrap in two phases.

### Phase 0 — prerequisites (manual, once)
1. Create a DO API token (read/write). Export it: `export DIGITALOCEAN_TOKEN=...`
2. Create Spaces access keys (API > Spaces Keys).
3. Create the state bucket by hand in the DO panel: `upq-tfstate` (NYC3).
4. Upload your SSH public key to DO; note its fingerprint.
5. Put your **real** SSH public key into `cloud-init/app.yaml` (the deploy user).
6. Generate an `age` keypair for backups: `age-keygen -o age-key.txt`
   (keep the private key OFF the server and out of git; the public key is the recipient).

### Phase 1 — provision
```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars   # fill in your values
export AWS_ACCESS_KEY_ID=<spaces key>          # state backend auth
export AWS_SECRET_ACCESS_KEY=<spaces secret>
terraform init
terraform plan      # review carefully
terraform apply
```

### Phase 2 — wire up the app
1. Grab connection details: `terraform output -raw db_app_password`, etc.
2. SSH in as `deploy`, drop `scripts/Caddyfile` at `/etc/caddy/Caddyfile`
   (edit the domain), `systemctl reload caddy`.
3. Put DB creds + Stripe keys in the app's `.env` on the droplet (chmod 600).
4. Put `scripts/backup.sh` + `/etc/upq/backup.env` on the droplet, add a cron entry:
   `0 3 * * * /home/deploy/backup.sh >> /var/log/upq-backup.log 2>&1`
5. Add all GitHub Actions secrets (listed in each workflow file).
6. Push to main — CI deploys the app and runs migrations.

## Security notes

- The DB has **no public access** — it's firewalled to the droplet over the VPC.
- SSH is **key-only**, root login disabled, ideally locked to your IP (`ssh_allowed_cidrs`).
- Backups are **encrypted with age before upload** — neither Spaces nor B2 sees plaintext.
- `prevent_destroy` is set on the droplet and DB so a stray `terraform destroy`
  can't wipe production.
- **Stripe webhooks**: expose an HTTPS endpoint (Caddy handles TLS) and verify the
  signing secret in your Node handler. Add the webhook secret to the app `.env`.

## Reminder: test your restores

A backup you've never restored is a guess, not a backup. Once a month, decrypt a
dump and restore it into a throwaway database. Restore steps are documented at the
bottom of `scripts/backup.sh`.

## The separate WebSocket issue

The macOS-Reminders → UpQ WebSocket timeout is a **client-side** bug (missing
heartbeat/reconnect), independent of this infrastructure. It's parked for a
separate effort; moving hosts won't fix it on its own.
```
