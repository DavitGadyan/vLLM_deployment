output "network_id" {
  description = "VPC network id"
  value       = google_compute_network.main.id
}

output "network_name" {
  description = "VPC network name"
  value       = google_compute_network.main.name
}

output "subnet_id" {
  description = "Node subnet id"
  value       = google_compute_subnetwork.main.id
}

output "subnet_name" {
  description = "Node subnet name"
  value       = google_compute_subnetwork.main.name
}

output "pods_range_name" {
  description = "Secondary range name for pods"
  value       = "${var.name_prefix}-pods"
}

output "services_range_name" {
  description = "Secondary range name for services"
  value       = "${var.name_prefix}-services"
}

output "private_service_connection" {
  description = "Private services connection — Cloud SQL must depend on this"
  value       = google_service_networking_connection.private_service_access.id
}
