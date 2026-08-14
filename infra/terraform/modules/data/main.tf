/**
 * Cloud SQL (Postgres + pgvector), Artifact Registry, and the GCS bucket for
 * model artifacts.
 *
 * The database is private-IP only. There is no public endpoint to misconfigure,
 * and reaching it requires being inside the VPC.
 */

# --- Artifact Registry ------------------------------------------------------
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "${var.name_prefix}-images"
  format        = "DOCKER"
  description   = "Application, serving and model images"

  cleanup_policies {
    id     = "keep-recent-releases"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-old-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s" # 7 days
    }
  }
}

# --- Model artifacts --------------------------------------------------------
resource "google_storage_bucket" "models" {
  name     = "${var.project_id}-${var.name_prefix}-models"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Quantized checkpoints are expensive to regenerate (GPU hours) and are the
  # exact bytes that passed the quality gate, so versioning is worth the storage.
  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 3
    }
    action {
      type = "Delete"
    }
  }
}

# --- Cloud SQL --------------------------------------------------------------
resource "google_sql_database_instance" "main" {
  name                = "${var.name_prefix}-postgres"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = var.deletion_protection

  # The private services connection must exist before an instance can attach
  # to it; without this dependency the apply fails intermittently.
  depends_on = [var.private_service_connection]

  settings {
    tier              = var.db_tier
    availability_type = var.db_high_availability ? "REGIONAL" : "ZONAL"
    disk_size         = var.db_disk_size_gb
    disk_type         = "PD_SSD"
    disk_autoresize   = true

    ip_configuration {
      # No public IP. Access is from inside the VPC only.
      ipv4_enabled                                  = false
      private_network                               = var.network_id
      enable_private_path_for_google_cloud_services = true
      ssl_mode                                      = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = var.db_high_availability
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
      }
    }

    database_flags {
      # pgvector must be preloaded for HNSW index builds to use parallel workers.
      name  = "cloudsql.enable_pgvector"
      value = "on"
    }

    database_flags {
      # Log slow queries. An HNSW search that starts spilling shows up here
      # before it shows up as user-visible latency.
      name  = "log_min_duration_statement"
      value = "1000"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
    }

    maintenance_window {
      day  = 7 # Sunday
      hour = 4
    }
  }
}

resource "google_sql_database" "support" {
  name     = var.db_name
  instance = google_sql_database_instance.main.name
}

resource "random_password" "db" {
  length  = 32
  special = true
  # Excluded because these characters need escaping inside a DSN and break
  # naive URL construction.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "google_sql_user" "app" {
  name     = var.db_user
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}

# --- Secrets ----------------------------------------------------------------
resource "google_secret_manager_secret" "db_password" {
  secret_id = "${var.name_prefix}-db-password"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
}

resource "random_password" "vllm_api_key" {
  length  = 40
  special = false
}

resource "google_secret_manager_secret" "vllm_api_key" {
  secret_id = "${var.name_prefix}-vllm-api-key"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "vllm_api_key" {
  secret      = google_secret_manager_secret.vllm_api_key.id
  secret_data = random_password.vllm_api_key.result
}
