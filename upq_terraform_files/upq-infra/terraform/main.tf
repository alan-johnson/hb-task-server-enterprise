# ---------------------------------------------------------------------------
# Private network — keeps app <-> DB traffic off the public internet.
# ---------------------------------------------------------------------------
resource "digitalocean_vpc" "upq" {
  name   = "upq-vpc"
  region = var.do_region
}

# ---------------------------------------------------------------------------
# Application droplet (Node app + reverse proxy). Hardened via cloud-init.
# ---------------------------------------------------------------------------
resource "digitalocean_droplet" "app" {
  name     = "upq-app"
  region   = var.do_region
  size     = var.droplet_size
  image    = var.droplet_image
  vpc_uuid = digitalocean_vpc.upq.id

  ssh_keys = [var.ssh_key_fingerprint]

  # cloud-init runs on first boot: creates non-root sudo user, hardens SSH,
  # sets up ufw + fail2ban, installs Node + Caddy + Flyway, enables auto-updates.
  user_data = file("${path.module}/../cloud-init/app.yaml")

  monitoring = true

  lifecycle {
    # Prevents an accidental `terraform destroy` of your live server.
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Managed MySQL cluster. DO handles patching, backups, PITR, failover.
# ---------------------------------------------------------------------------
resource "digitalocean_database_cluster" "mysql" {
  name       = "upq-mysql"
  engine     = "mysql"
  version    = "8.4"
  size       = var.db_size
  region     = var.do_region
  node_count = var.db_node_count
  private_network_uuid = digitalocean_vpc.upq.id

  lifecycle {
    prevent_destroy = true
  }
}

# A dedicated application database inside the cluster.
resource "digitalocean_database_db" "upq" {
  cluster_id = digitalocean_database_cluster.mysql.id
  name       = "upq"
}

# A dedicated DB user for the app (NOT the default admin user).
resource "digitalocean_database_user" "app" {
  cluster_id = digitalocean_database_cluster.mysql.id
  name       = "upq_app"
}

# Restrict the DB so ONLY the app droplet (and optionally your IP) can connect.
resource "digitalocean_database_firewall" "mysql" {
  cluster_id = digitalocean_database_cluster.mysql.id

  rule {
    type  = "droplet"
    value = digitalocean_droplet.app.id
  }
}

# ---------------------------------------------------------------------------
# Cloud firewall on the droplet: only SSH (restricted), HTTP, HTTPS inbound.
# ---------------------------------------------------------------------------
resource "digitalocean_firewall" "app" {
  name        = "upq-app-fw"
  droplet_ids = [digitalocean_droplet.app.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_cidrs
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Allow all outbound (needed for package installs, Stripe API, Let's Encrypt).
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# ---------------------------------------------------------------------------
# Spaces bucket for encrypted DB backup mirror (the off-site leg of 3-2-1).
# ---------------------------------------------------------------------------
resource "digitalocean_spaces_bucket" "backups" {
  name   = "upq-backups"
  region = var.do_region
  acl    = "private"

  versioning {
    enabled = true
  }

  # Expire old backups automatically so storage doesn't grow forever.
  lifecycle_rule {
    enabled = true
    expiration {
      days = 35
    }
  }
}

# ---------------------------------------------------------------------------
# Optional DNS (only if var.domain is set).
# ---------------------------------------------------------------------------
resource "digitalocean_domain" "primary" {
  count = var.domain == "" ? 0 : 1
  name  = var.domain
}

resource "digitalocean_record" "apex" {
  count  = var.domain == "" ? 0 : 1
  domain = digitalocean_domain.primary[0].name
  type   = "A"
  name   = "@"
  value  = digitalocean_droplet.app.ipv4_address
  ttl    = 300
}

resource "digitalocean_record" "www" {
  count  = var.domain == "" ? 0 : 1
  domain = digitalocean_domain.primary[0].name
  type   = "A"
  name   = "www"
  value  = digitalocean_droplet.app.ipv4_address
  ttl    = 300
}

# ---------------------------------------------------------------------------
# Group everything under one DO project for tidy billing/organization.
# ---------------------------------------------------------------------------
resource "digitalocean_project" "upq" {
  name        = var.project_name
  description = "UpQ task-manager SaaS"
  purpose     = "Web Application"
  environment = "Production"

  resources = compact([
    digitalocean_droplet.app.urn,
    digitalocean_database_cluster.mysql.urn,
    digitalocean_spaces_bucket.backups.urn,
    var.domain == "" ? "" : digitalocean_domain.primary[0].urn,
  ])
}
