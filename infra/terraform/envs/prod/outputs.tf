output "get_credentials" {
  value = module.gke.get_credentials_command
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
  value = module.iam.backend_service_account_email
}

output "vllm_service_account" {
  value = module.iam.vllm_service_account_email
}

output "ci_service_account" {
  value = module.iam.ci_service_account_email
}
