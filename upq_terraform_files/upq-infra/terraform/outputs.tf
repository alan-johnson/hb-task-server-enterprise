output "app_ipv4" {
  description = "Public IP of the app droplet. Point your domain here."
  value       = digitalocean_droplet.app.ipv4_address
}

output "app_private_ip" {
  description = "Private VPC IP of the droplet."
  value       = digitalocean_droplet.app.ipv4_address_private
}

# --- Database connection details (sensitive) -------------------------------
# View with: terraform output -raw db_private_host  (etc.)
# Use the PRIVATE host so traffic stays on the VPC.

output "db_private_host" {
  description = "Private hostname for the MySQL cluster (use this from the app)."
  value       = digitalocean_database_cluster.mysql.private_host
  sensitive   = true
}

output "db_port" {
  value = digitalocean_database_cluster.mysql.port
}

output "db_name" {
  value = digitalocean_database_db.upq.name
}

output "db_app_user" {
  value = digitalocean_database_user.app.name
}

output "db_app_password" {
  description = "Password for the app DB user. Feed into the app's secrets, never commit."
  value       = digitalocean_database_user.app.password
  sensitive   = true
}

output "db_ca_cert" {
  description = "CA cert for verified TLS connections to MySQL."
  value       = digitalocean_database_cluster.mysql.private_uri
  sensitive   = true
}
