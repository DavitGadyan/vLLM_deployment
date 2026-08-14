output "registry_url" {
  description = "Artifact Registry host path for image pushes"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "models_bucket" {
  value = google_storage_bucket.models.name
}

output "db_instance_name" {
  value = google_sql_database_instance.main.name
}

output "db_private_ip" {
  value     = google_sql_database_instance.main.private_ip_address
  sensitive = true
}

output "db_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "db_name" {
  value = google_sql_database.support.name
}

output "db_user" {
  value = google_sql_user.app.name
}

output "db_password_secret_id" {
  description = "Secret Manager id holding the database password"
  value       = google_secret_manager_secret.db_password.secret_id
}

output "vllm_api_key_secret_id" {
  value = google_secret_manager_secret.vllm_api_key.secret_id
}
