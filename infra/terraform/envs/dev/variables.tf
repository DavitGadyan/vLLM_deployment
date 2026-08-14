variable "project_id" {
  description = "GCP project id"
  type        = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "namespace" {
  description = "Kubernetes namespace the workloads run in"
  type        = string
  default     = "support"
}

variable "gpu_zones" {
  description = "Zones with L4 capacity"
  type        = list(string)
  default     = ["us-central1-a", "us-central1-c"]
}

variable "authorized_networks" {
  description = "CIDRs allowed to reach the Kubernetes API"
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default = []
}
