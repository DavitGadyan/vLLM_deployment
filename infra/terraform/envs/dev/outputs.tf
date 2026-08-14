output "get_credentials" {
  description = "Configure kubectl for this cluster"
  value       = module.gke.get_credentials_command
}

output "registry_url" {
  value = module.data.registry_url
}

output "models_bucket" {
  value = module.data.models_bucket
}

output "db_connection_name" {
  value = module.data.db_connection_name
}

output "backend_service_account" {
  description = "Annotate the support-backend Kubernetes service account with this"
  value       = module.iam.backend_service_account_email
}

output "vllm_service_account" {
  description = "Annotate the support-vllm Kubernetes service account with this"
  value       = module.iam.vllm_service_account_email
}

output "helm_values_hint" {
  description = "Values to pass to the Helm charts"
  value = {
    registry              = module.data.registry_url
    dbConnectionName      = module.data.db_connection_name
    dbPasswordSecret      = module.data.db_password_secret_id
    vllmApiKeySecret      = module.data.vllm_api_key_secret_id
    backendServiceAccount = module.iam.backend_service_account_email
    vllmServiceAccount    = module.iam.vllm_service_account_email
  }
}
