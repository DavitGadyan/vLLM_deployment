output "node_service_account_email" {
  value = google_service_account.nodes.email
}

output "backend_service_account_email" {
  description = "Annotate the support-backend KSA with this"
  value       = google_service_account.backend.email
}

output "vllm_service_account_email" {
  description = "Annotate the support-vllm KSA with this"
  value       = google_service_account.vllm.email
}

output "ci_service_account_email" {
  value = google_service_account.ci.email
}
