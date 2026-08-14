/**
 * Production environment.
 *
 * Differs from dev in the places that matter under load and under failure:
 * regional database with point-in-time recovery, deletion protection on, and a
 * GPU pool with a warm minimum so autoscaling adds capacity from a running
 * baseline rather than from a cold start.
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
    prefix = "support-assistant/prod"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  name_prefix = "support-prod"
}

module "network" {
  source = "../../modules/network"

  name_prefix = local.name_prefix
  region      = var.region

  # Distinct from dev so the two VPCs can be peered later without renumbering.
  subnet_cidr   = "10.40.0.0/20"
  pods_cidr     = "10.50.0.0/16"
  services_cidr = "10.60.0.0/20"
  master_cidr   = "172.16.1.0/28"
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

  db_tier              = var.db_tier
  db_disk_size_gb      = 100
  db_high_availability = true
  deletion_protection  = true
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
  master_cidr         = "172.16.1.0/28"

  node_service_account = module.iam.node_service_account_email
  authorized_networks  = var.authorized_networks

  cpu_machine_type = "e2-standard-4"
  cpu_min_nodes    = 2
  cpu_max_nodes    = 10

  gpu_machine_type = var.gpu_machine_type
  gpu_zones        = var.gpu_zones
  # Never scale GPUs to zero in production. A vLLM pod takes minutes to become
  # ready, so a cold start during a traffic spike means the queue is already
  # deep before the first replica can serve anything.
  gpu_min_nodes = var.gpu_min_nodes
  gpu_max_nodes = var.gpu_max_nodes

  deletion_protection = true
}
