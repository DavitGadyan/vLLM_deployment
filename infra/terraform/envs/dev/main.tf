/**
 * Development environment.
 *
 * Sized to be cheap rather than resilient: a single zonal database, no HA, and
 * a GPU pool that scales to zero when nothing is running. An idle L4 node costs
 * real money every hour, and a dev cluster is idle most of the time.
 */

terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.14"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "gcs" {
    # bucket is supplied by `terraform init -backend-config=backend.hcl`
    # so the state location is not hardcoded per environment.
    prefix = "support-assistant/dev"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  name_prefix = "support-dev"
}

module "network" {
  source = "../../modules/network"

  name_prefix = local.name_prefix
  region      = var.region
}

module "iam" {
  source = "../../modules/iam"

  project_id             = var.project_id
  name_prefix            = local.name_prefix
  namespace              = var.namespace
  models_bucket          = module.data.models_bucket
  db_password_secret_id  = module.data.db_password_secret_id
  vllm_api_key_secret_id = module.data.vllm_api_key_secret_id
}

module "data" {
  source = "../../modules/data"

  project_id                 = var.project_id
  name_prefix                = local.name_prefix
  region                     = var.region
  network_id                 = module.network.network_id
  private_service_connection = module.network.private_service_connection

  db_tier              = "db-custom-1-3840"
  db_disk_size_gb      = 20
  db_high_availability = false
  deletion_protection  = false
}

module "gke" {
  source = "../../modules/gke"

  project_id          = var.project_id
  name_prefix         = local.name_prefix
  region              = var.region
  network_id          = module.network.network_id
  subnet_id           = module.network.subnet_id
  pods_range_name     = module.network.pods_range_name
  services_range_name = module.network.services_range_name

  node_service_account = module.iam.node_service_account_email
  authorized_networks  = var.authorized_networks

  cpu_machine_type = "e2-standard-4"
  cpu_min_nodes    = 1
  cpu_max_nodes    = 3

  gpu_machine_type = "g2-standard-8"
  gpu_zones        = var.gpu_zones
  # Scale to zero: no GPU cost while dev is idle. The trade is a several-minute
  # cold start on the first request after a quiet period.
  gpu_min_nodes = 0
  gpu_max_nodes = 1

  deletion_protection = false
}
