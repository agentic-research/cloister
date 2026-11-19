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

# A plan for a system that can really be started: every image is the public
# Kubernetes test image. `dev/lowered-kind.sh drafted` drafts a cluster.toml
# from the rendered plan, lowers it, applies it to a kind cluster, and checks
# that the graph the plan implies is the one the cluster enforces.

resource "google_cloud_run_v2_service" "server" {
  name     = "server"
  location = "us-central1"
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    containers {
      image   = "registry.k8s.io/e2e-test-images/agnhost:2.53"
      command = ["/agnhost"]
      args    = ["netexec", "--http-port=8080"]
      ports {
        name           = "http1"
        container_port = 8080
      }
    }
  }
}

resource "google_cloud_run_v2_service" "caller" {
  name     = "caller"
  location = "us-central1"
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    containers {
      image   = "registry.k8s.io/e2e-test-images/agnhost:2.53"
      command = ["/agnhost"]
      args    = ["pause"]
      env {
        name  = "SERVER_URL"
        value = google_cloud_run_v2_service.server.uri
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
    }
  }
}

resource "google_cloud_run_v2_service" "stranger" {
  name     = "stranger"
  location = "us-central1"
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    containers {
      image   = "registry.k8s.io/e2e-test-images/agnhost:2.53"
      command = ["/agnhost"]
      args    = ["pause"]
    }
  }
}

resource "google_cloud_run_v2_job" "probe" {
  name     = "probe"
  location = "us-central1"
  template {
    template {
      containers {
        image   = "registry.k8s.io/e2e-test-images/agnhost:2.53"
        command = ["sh"]
        args    = ["-c", "curl -fsS --max-time 20 \"$SERVER_URL/hostname\""]
        env {
          name  = "SERVER_URL"
          value = google_cloud_run_v2_service.server.uri
        }
      }
    }
  }
}
