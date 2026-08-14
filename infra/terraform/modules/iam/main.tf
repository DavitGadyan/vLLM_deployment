/**
 * Service accounts and Workload Identity bindings.
 *
 * There is not a single service account key anywhere in this system. Pods
 * authenticate as their Kubernetes service account, which is bound to a Google
 * service account through Workload Identity. That removes the entire class of
 * incident where a key ends up in a container image, a git history, or a log.
 */

# --- Node service account ---------------------------------------------------
# Deliberately minimal: nodes need to pull images and write telemetry, nothing
# more. Application permissions belong to the workload identities below.
resource "google_service_account" "nodes" {
  account_id   = "${var.name_prefix}-nodes"
  display_name = "GKE nodes (${var.name_prefix})"
}

resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
    "roles/artifactregistry.reader",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

# --- Backend workload -------------------------------------------------------
resource "google_service_account" "backend" {
  account_id   = "${var.name_prefix}-backend"
  display_name = "Support backend workload"
}

resource "google_secret_manager_secret_iam_member" "backend_db_password" {
  secret_id = var.db_password_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_secret_manager_secret_iam_member" "backend_vllm_key" {
  secret_id = var.vllm_api_key_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_project_iam_member" "backend_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_service_account_iam_member" "backend_workload_identity" {
  service_account_id = google_service_account.backend.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.namespace}/support-backend]"
}

# --- vLLM workload ----------------------------------------------------------
# Read-only on the model bucket. The serving pod has no reason to write
# anything, so it cannot.
resource "google_service_account" "vllm" {
  account_id   = "${var.name_prefix}-vllm"
  display_name = "vLLM serving workload"
}

resource "google_storage_bucket_iam_member" "vllm_models" {
  bucket = var.models_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.vllm.email}"
}

resource "google_secret_manager_secret_iam_member" "vllm_api_key" {
  secret_id = var.vllm_api_key_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vllm.email}"
}

resource "google_service_account_iam_member" "vllm_workload_identity" {
  service_account_id = google_service_account.vllm.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.namespace}/support-vllm]"
}

# --- CI ---------------------------------------------------------------------
# Impersonated via Workload Identity Federation from GitHub Actions, so CI also
# holds no long-lived key.
resource "google_service_account" "ci" {
  account_id   = "${var.name_prefix}-ci"
  display_name = "CI: build, push, deploy"
}

resource "google_project_iam_member" "ci" {
  for_each = toset([
    "roles/artifactregistry.writer",
    "roles/container.developer",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_storage_bucket_iam_member" "ci_models" {
  bucket = var.models_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.ci.email}"
}
