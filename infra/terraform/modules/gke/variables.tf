variable "project_id" {
  description = "GCP project id"
  type        = string
}

variable "name_prefix" {
  type = string
}

variable "region" {
  type = string
}

variable "network_id" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "pods_range_name" {
  type = string
}

variable "services_range_name" {
  type = string
}

variable "master_cidr" {
  description = "Control plane CIDR. Must not overlap the VPC."
  type        = string
  default     = "172.16.0.0/28"
}

variable "authorized_networks" {
  description = "CIDRs allowed to reach the Kubernetes API"
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default = []
}

variable "node_service_account" {
  description = "Service account email for cluster nodes"
  type        = string
}

variable "release_channel" {
  type    = string
  default = "REGULAR"
}

variable "enable_managed_prometheus" {
  description = "Google Managed Prometheus. Disable when running self-hosted kube-prometheus-stack to avoid double-scraping."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  type    = bool
  default = true
}

# --- CPU pool -------------------------------------------------------------
variable "cpu_machine_type" {
  type    = string
  default = "e2-standard-4"
}

variable "cpu_min_nodes" {
  type    = number
  default = 1
}

variable "cpu_max_nodes" {
  type    = number
  default = 6
}

# --- GPU pool -------------------------------------------------------------
variable "gpu_machine_type" {
  description = "Must be a G2 machine type when using nvidia-l4"
  type        = string
  default     = "g2-standard-8"
}

variable "gpu_type" {
  type    = string
  default = "nvidia-l4"
}

variable "gpus_per_node" {
  type    = number
  default = 1
}

variable "gpu_zones" {
  description = "Zones with L4 capacity. Pin explicitly — availability varies within a region."
  type        = list(string)
  default     = ["us-central1-a", "us-central1-c"]
}

variable "gpu_min_nodes" {
  description = "Set to 0 for dev to avoid paying for an idle GPU; keep >=1 in prod so a scale-up is not a cold start."
  type        = number
  default     = 1
}

variable "gpu_max_nodes" {
  type    = number
  default = 4
}
