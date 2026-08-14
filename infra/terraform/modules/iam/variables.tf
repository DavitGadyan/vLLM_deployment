variable "project_id" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "namespace" {
  description = "Kubernetes namespace the workloads run in"
  type        = string
  default     = "support"
}

variable "models_bucket" {
  type = string
}

variable "db_password_secret_id" {
  type = string
}

variable "vllm_api_key_secret_id" {
  type = string
}
