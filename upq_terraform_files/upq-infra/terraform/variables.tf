variable "do_region" {
  description = "DigitalOcean region. NYC = closest to Chicago."
  type        = string
  default     = "nyc3"
}

variable "project_name" {
  description = "Name shown in the DO control panel project grouping."
  type        = string
  default     = "UpQ"
}

variable "droplet_size" {
  description = "Droplet slug. s-1vcpu-2gb is the ~$18/mo launch size."
  type        = string
  default     = "s-1vcpu-2gb"
}

variable "droplet_image" {
  description = "Base OS image."
  type        = string
  default     = "ubuntu-24-04-x64"
}

variable "db_size" {
  description = "Managed MySQL node size. db-s-1vcpu-1gb is the ~$15/mo starter."
  type        = string
  default     = "db-s-1vcpu-1gb"
}

variable "db_node_count" {
  description = "1 = single node (launch). Set to 2 later to add a standby for HA."
  type        = number
  default     = 1
}

variable "ssh_key_fingerprint" {
  description = "Fingerprint of an SSH key already uploaded to your DO account. Get it from the DO control panel (Settings > Security) or `doctl compute ssh-key list`."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "Source IPs allowed to reach SSH (port 22). Lock this to your own IP, NOT 0.0.0.0/0, for real hardening."
  type        = list(string)
  default     = ["0.0.0.0/0"] # CHANGE THIS to your /32 before production
}

variable "domain" {
  description = "Your apex domain, e.g. upq.app. Leave empty to skip DNS management in Terraform."
  type        = string
  default     = ""
}

# Spaces credentials for the provider (state backend uses AWS_* env vars instead).
variable "spaces_access_id" {
  type      = string
  sensitive = true
}

variable "spaces_secret_key" {
  type      = string
  sensitive = true
}
