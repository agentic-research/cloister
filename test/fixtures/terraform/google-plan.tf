terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "6.50.0" }
  }
}

provider "google" {
  project      = "example-project"
  region       = "us-central1"
  access_token = "placeholder"
}

variable "api_token" {
  type      = string
  sensitive = true
  default   = "FIXTURE-SENSITIVE-VALUE"
}

resource "google_cloud_run_v2_service" "reconciler" {
  name     = "reconciler"
  location = "us-central1"
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    containers {
      image = "example.com/reconciler:1"
      ports {
        name           = "h2c"
        container_port = 8080
      }
    }
  }
}

resource "google_cloud_run_v2_service" "workqueue" {
  name     = "workqueue"
  location = "us-central1"
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    containers {
      image = "example.com/workqueue:1"
      args  = ["--workers", "4"]
      env {
        name  = "RECONCILER_URL"
        value = google_cloud_run_v2_service.reconciler.uri
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "API_TOKEN"
        value = var.api_token
      }
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = "db-password"
            version = "latest"
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_job" "sweep" {
  name     = "sweep"
  location = "us-central1"
  template {
    template {
      containers {
        image = "example.com/sweep:1"
        env {
          name  = "TARGET"
          value = "${google_cloud_run_v2_service.reconciler.uri}/sweep"
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "workqueue_calls_reconciler" {
  name     = google_cloud_run_v2_service.reconciler.name
  location = "us-central1"
  role     = "roles/run.invoker"
  member   = "serviceAccount:workqueue@example-project.iam.gserviceaccount.com"
}
