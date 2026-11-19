terraform {
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "2.38.0" }
  }
}

provider "kubernetes" {
  host  = "https://127.0.0.1:6443"
  token = "placeholder"
}

# The same small system as test/e2e/drafted-kind, declared as Kubernetes
# resources in Terraform. Read by `cloister inspect` from the rendered plan.

resource "kubernetes_namespace_v1" "shop" {
  metadata { name = "shop" }
}

resource "kubernetes_deployment_v1" "server" {
  metadata {
    name      = "server"
    namespace = "shop"
  }
  spec {
    replicas = 1
    selector { match_labels = { app = "server" } }
    template {
      metadata { labels = { app = "server" } }
      spec {
        container {
          name    = "server"
          image   = "registry.k8s.io/e2e-test-images/agnhost:2.53"
          command = ["/agnhost"]
          args    = ["netexec", "--http-port=8080"]
          port {
            name           = "http"
            container_port = 8080
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "server" {
  metadata {
    name      = "server"
    namespace = "shop"
  }
  spec {
    selector = { app = "server" }
    port {
      name        = "http"
      port        = 8080
      target_port = 8080
    }
  }
}

resource "kubernetes_deployment_v1" "caller" {
  metadata {
    name      = "caller"
    namespace = "shop"
  }
  spec {
    replicas = 1
    selector { match_labels = { app = "caller" } }
    template {
      metadata { labels = { app = "caller" } }
      spec {
        container {
          name    = "caller"
          image   = "registry.k8s.io/e2e-test-images/agnhost:2.53"
          command = ["/agnhost"]
          args    = ["pause"]
          env {
            name  = "SERVER_URL"
            value = "http://${kubernetes_service_v1.server.metadata[0].name}.${kubernetes_service_v1.server.metadata[0].namespace}.svc.cluster.local:8080"
          }
          env {
            name  = "LOG_LEVEL"
            value = "info"
          }
          env {
            name = "DB_PASSWORD"
            value_from {
              secret_key_ref {
                name = "db-password"
                key  = "latest"
              }
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_job_v1" "probe" {
  metadata {
    name      = "probe"
    namespace = "shop"
  }
  spec {
    template {
      metadata { labels = { app = "probe" } }
      spec {
        restart_policy = "Never"
        container {
          name    = "probe"
          image   = "registry.k8s.io/e2e-test-images/agnhost:2.53"
          command = ["sh"]
          args    = ["-c", "curl -fsS --max-time 20 \"$SERVER_URL/hostname\""]
          env {
            name  = "SERVER_URL"
            value = "http://server.shop.svc.cluster.local:8080"
          }
        }
      }
    }
  }
  wait_for_completion = false
}
