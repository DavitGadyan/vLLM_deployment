output "cluster_name" {
  value = google_container_cluster.main.name
}

output "cluster_endpoint" {
  value     = google_container_cluster.main.endpoint
  sensitive = true
}

output "cluster_ca_certificate" {
  value     = google_container_cluster.main.master_auth[0].cluster_ca_certificate
  sensitive = true
}

output "workload_identity_pool" {
  value = "${var.project_id}.svc.id.goog"
}

output "gpu_node_pool" {
  value = google_container_node_pool.gpu.name
}

output "cpu_node_pool" {
  value = google_container_node_pool.cpu.name
}

output "get_credentials_command" {
  description = "Run this to configure kubectl"
  value = join(" ", [
    "gcloud container clusters get-credentials",
    google_container_cluster.main.name,
    "--region", var.region,
    "--project", var.project_id,
  ])
}
