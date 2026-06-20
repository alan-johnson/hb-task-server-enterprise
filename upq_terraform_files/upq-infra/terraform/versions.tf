terraform {
  required_version = ">= 1.7.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }

  # Remote state in DO Spaces (S3-compatible).
  # Spaces is configured as an S3 backend. You must create the bucket ONCE by hand
  # (or via a bootstrap apply with a local backend) before enabling this block,
  # because Terraform can't store state in a bucket it hasn't created yet.
  #
  # Fill endpoint/region to match your Spaces bucket, then run:
  #   terraform init -reconfigure
  #
  # Credentials come from env vars, NOT this file:
  #   AWS_ACCESS_KEY_ID     = <Spaces access key>
  #   AWS_SECRET_ACCESS_KEY = <Spaces secret key>
  backend "s3" {
    bucket = "upq-tfstate"            # your Spaces bucket name
    key    = "prod/terraform.tfstate"
    region = "us-east-1"              # dummy value; Spaces ignores it but the backend requires it

    endpoints = {
      s3 = "https://nyc3.digitaloceanspaces.com"
    }

    # These flags tell the S3 backend not to expect real AWS:
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "digitalocean" {
  # token comes from env var DIGITALOCEAN_TOKEN — never hard-code it
  spaces_access_id  = var.spaces_access_id
  spaces_secret_key = var.spaces_secret_key
}
