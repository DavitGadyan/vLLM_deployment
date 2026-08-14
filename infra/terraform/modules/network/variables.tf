variable "name_prefix" {
  description = "Prefix applied to every resource name in this module"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
}

variable "subnet_cidr" {
  description = "Primary node subnet CIDR"
  type        = string
  default     = "10.10.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary range for pods. Cannot be resized after cluster creation, so size for the cluster's eventual maximum."
  type        = string
  default     = "10.20.0.0/16"
}

variable "services_cidr" {
  description = "Secondary range for Kubernetes services"
  type        = string
  default     = "10.30.0.0/20"
}

variable "master_cidr" {
  description = "CIDR of the GKE control plane, allowed to reach node webhook ports"
  type        = string
  default     = "172.16.0.0/28"
}
