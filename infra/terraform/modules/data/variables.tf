variable "project_id" {
  type = string
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

variable "private_service_connection" {
  description = "Private services connection id — the SQL instance depends on it"
  type        = string
}

variable "db_tier" {
  description = "Cloud SQL machine tier. The workload is small rows plus HNSW vector search; memory matters more than CPU."
  type        = string
  default     = "db-custom-2-7680"
}

variable "db_disk_size_gb" {
  type    = number
  default = 50
}

variable "db_high_availability" {
  description = "Regional failover plus point-in-time recovery. Roughly doubles cost."
  type        = bool
  default     = false
}

variable "db_name" {
  type    = string
  default = "support"
}

variable "db_user" {
  type    = string
  default = "support"
}

variable "deletion_protection" {
  type    = bool
  default = true
}
