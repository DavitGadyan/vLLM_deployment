/**
 * VPC for a private GKE cluster.
 *
 * Nodes have no external IPs. Egress (pulling images, reaching Google APIs)
 * goes through Cloud NAT, so the cluster's outbound address is a single known
 * IP rather than one per node — which is what makes egress auditable and
 * allowlistable at a partner's firewall.
 */

resource "google_compute_network" "main" {
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  description             = "VPC for the support assistant platform"
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.name_prefix}-subnet"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = var.subnet_cidr

  # Secondary ranges for GKE pods and services. Sized deliberately: the pod
  # range caps how many pods the cluster can ever run, and it cannot be resized
  # after the cluster is created.
  secondary_ip_range {
    range_name    = "${var.name_prefix}-pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "${var.name_prefix}-services"
    ip_cidr_range = var.services_cidr
  }

  # Lets nodes reach Google APIs without an external IP.
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_10_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_router" "main" {
  name    = "${var.name_prefix}-router"
  network = google_compute_network.main.id
  region  = var.region
}

resource "google_compute_router_nat" "main" {
  name                               = "${var.name_prefix}-nat"
  router                             = google_compute_router.main.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# Reserved range for the Cloud SQL private services connection. Without this,
# the database would need a public IP.
resource "google_compute_global_address" "private_service_access" {
  name          = "${var.name_prefix}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_service_access" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_access.name]
}

# The GKE control plane needs to reach admission webhooks on nodes; a private
# cluster blocks that by default and the failure looks like a hung deployment.
resource "google_compute_firewall" "control_plane_to_nodes" {
  name      = "${var.name_prefix}-cp-to-nodes"
  network   = google_compute_network.main.name
  direction = "INGRESS"

  source_ranges = [var.master_cidr]

  allow {
    protocol = "tcp"
    ports    = ["8443", "9443", "15017"]
  }
}
