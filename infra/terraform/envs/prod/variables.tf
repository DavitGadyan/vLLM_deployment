variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "namespace" {
  type    = string
  default = "support"
}

variable "db_tier" {
  type    = string
  default = "db-custom-4-15360"
}

variable "gpu_machine_type" {
  type    = string
  default = "g2-standard-8"
}

variable "gpu_zones" {
  type    = list(string)
  default = ["us-central1-a", "us-central1-c"]
}

variable "gpu_min_nodes" {
  description = "Warm baseline. Keep >= 1 so a scale-up is not a cold start."
  type        = number
  default     = 2
}

variable "gpu_max_nodes" {
  type    = number
  default = 8
}

variable "authorized_networks" {
  description = "CIDRs allowed to reach the Kubernetes API"
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default = []
}
