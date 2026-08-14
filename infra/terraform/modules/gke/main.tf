/**
 * Private GKE cluster with a CPU pool and a GPU pool.
 *
 * The two pools exist because their scaling behaviour is completely different:
 * the CPU pool runs stateless web/API pods that scale in seconds, while the GPU
 * pool runs vLLM replicas that take minutes to become ready (image pull, weight
 * load, CUDA graph capture). Mixing them would let a cheap frontend pod pin an
 * expensive GPU node alive, and would let GPU-node churn evict the API.
 */

resource "google_container_cluster" "main" {
  name     = "${var.name_prefix}-gke"
  location = var.region

  # Terraform manages node pools separately, so the default pool is removed
  # immediately after creation.
  remove_default_node_pool = true
  initial_node_count       = 1

  network    = var.network_id
  subnetwork = var.subnet_id

  networking_mode = "VPC_NATIVE"
  ip_allocation_policy {
    cluster_secondary_range_name  = var.pods_range_name
    services_secondary_range_name = var.services_range_name
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false # kubectl from CI/operators; locked down below
    master_ipv4_cidr_block  = var.master_cidr
  }

  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.authorized_networks
      content {
        cidr_block   = cidr_blocks.value.cidr_block
        display_name = cidr_blocks.value.display_name
      }
    }
  }

  # Workload Identity: pods authenticate to Google APIs as a Kubernetes service
  # account mapped to a Google service account. This is what removes service
  # account JSON keys from the system entirely — there is no key to leak,
  # rotate, or accidentally commit.
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  release_channel {
    channel = var.release_channel
  }

  addons_config {
    horizontal_pod_autoscaling { disabled = false }
    http_load_balancing { disabled = false }
    gcp_filestore_csi_driver_config { enabled = false }
    gcs_fuse_csi_driver_config { enabled = true }
  }

  # Dataplane V2 gives NetworkPolicy enforcement without a separate Calico
  # install, which is how vLLM is restricted to backend pods only.
  datapath_provider = "ADVANCED_DATAPATH"

  monitoring_config {
    enable_components = [
      "SYSTEM_COMPONENTS",
      "WORKLOADS",
      "HPA",
    ]
    managed_prometheus { enabled = var.enable_managed_prometheus }
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  maintenance_policy {
    recurring_window {
      # Sunday early morning UTC — GPU node recycling is disruptive and slow.
      start_time = "2026-01-04T02:00:00Z"
      end_time   = "2026-01-04T08:00:00Z"
      recurrence = "FREQ=WEEKLY;BYDAY=SU"
    }
  }

  # Deleting a cluster silently is not something a `terraform apply` should be
  # able to do to production.
  deletion_protection = var.deletion_protection

  lifecycle {
    ignore_changes = [initial_node_count]
  }
}

# --- CPU pool: frontend, backend, embeddings ------------------------------
resource "google_container_node_pool" "cpu" {
  name     = "${var.name_prefix}-cpu"
  cluster  = google_container_cluster.main.id
  location = var.region

  initial_node_count = var.cpu_min_nodes

  autoscaling {
    min_node_count = var.cpu_min_nodes
    max_node_count = var.cpu_max_nodes
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    machine_type = var.cpu_machine_type
    disk_size_gb = 100
    disk_type    = "pd-balanced"

    service_account = var.node_service_account
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    labels = {
      workload = "general"
    }
  }
}

# --- GPU pool: vLLM --------------------------------------------------------
resource "google_container_node_pool" "gpu" {
  name     = "${var.name_prefix}-gpu"
  cluster  = google_container_cluster.main.id
  location = var.region

  # Pinned to specific zones. L4 availability is uneven across zones within a
  # region, and letting GKE choose produces intermittent "no GPU capacity"
  # failures that only appear during a scale-up under load.
  node_locations = var.gpu_zones

  initial_node_count = var.gpu_min_nodes

  autoscaling {
    min_node_count = var.gpu_min_nodes
    max_node_count = var.gpu_max_nodes
  }

  management {
    auto_repair  = true
    auto_upgrade = false # a surprise upgrade evicts a model that takes minutes to reload
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    # g2-standard-8: 8 vCPU, 32 GB RAM, 1x NVIDIA L4 (24 GB).
    machine_type = var.gpu_machine_type

    # 200 GB pd-balanced: the vLLM image plus the model image are ~20 GB
    # together, and disk throughput scales with size on pd-balanced, which
    # directly affects how fast a scaled-up pod loads weights.
    disk_size_gb = 200
    disk_type    = "pd-balanced"

    service_account = var.node_service_account
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    guest_accelerator {
      type  = var.gpu_type
      count = var.gpus_per_node

      # Required in practice despite the provider docs marking it optional —
      # omitting it produces nodes without drivers, which surfaces as pods stuck
      # in ContainerCreating with no obvious cause.
      gpu_driver_installation_config {
        gpu_driver_version = "LATEST"
      }
    }

    # Keeps non-GPU workloads off expensive nodes. vLLM tolerates this taint;
    # GKE adds the same taint automatically, and declaring it here makes the
    # contract explicit.
    taint {
      key    = "nvidia.com/gpu"
      value  = "present"
      effect = "NO_SCHEDULE"
    }

    labels = {
      workload = "inference"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }
  }
}
