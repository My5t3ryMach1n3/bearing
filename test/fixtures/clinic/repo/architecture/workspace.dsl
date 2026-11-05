workspace "Chairside clinic" "Chairside's target when everything runs in one Kubernetes cluster on the clinic's own server." {
  model {
    receptionist = person "Receptionist" "Books patients into open slots at the front desk" {
      properties {
        "bearing.requirements" "#1"
      }
    }

    chairside = softwareSystem "Chairside" "Books dental appointments" {
      properties {
        "bearing.requirements" "#1"
      }

      webApp = container "Web app" "The booking screens the front desk uses" "TypeScript, React, served by nginx" {
        properties {
          "bearing.requirements" "#1"
        }
      }
      bookingApi = container "Booking API" "Lists open slots and books them" "Python, FastAPI" {
        properties {
          "bearing.requirements" "#1"
        }
      }
      database = container "Database" "Holds clinicians, slots and appointments" "PostgreSQL 16" {
        tags "Database"
        properties {
          "bearing.requirements" "#1"
        }
      }
    }

    receptionist -> webApp "Books appointments with" "HTTPS" {
      properties {
        "bearing.requirements" "#1"
      }
    }
    webApp -> bookingApi "Calls" "JSON over HTTP" {
      properties {
        "bearing.requirements" "#1"
      }
    }
    bookingApi -> database "Reads and writes" "SQL" {
      properties {
        "bearing.requirements" "#1"
      }
    }

    clinic = deploymentEnvironment "Clinic" {
      server = deploymentNode "Clinic server" "The small PC in the clinic's comms cupboard" "Intel NUC, Ubuntu 24.04" {
        cluster = deploymentNode "k3s" "" "k3s" {
          namespace = deploymentNode "chairside" "" "Kubernetes Namespace" {
            ingress = infrastructureNode "Ingress" "Routes the front desk's requests" "Traefik Ingress"
            web = deploymentNode "web" "" "Kubernetes Deployment" "" 2 {
              containerInstance webApp
            }
            api = deploymentNode "Booking API" "" "Kubernetes Deployment" "" 2 {
              containerInstance bookingApi
            }
            db = deploymentNode "Database server" "" "PostgreSQL 16" {
              properties {
                "bearing.kubernetes" "StatefulSet/chairside/postgres"
              }
              containerInstance database
            }
          }
        }
      }
      ingress -> web "Routes / to" "HTTP"
      ingress -> api "Routes /api to" "HTTP"
    }
  }

  views {
    container chairside "containers" {
      include *
      autoLayout
    }
    deployment chairside clinic "clinic" {
      include *
      autoLayout
    }
  }
}
