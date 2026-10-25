workspace "Basket" {
  model {
    shopper = person "Shopper"
    email = softwareSystem "Email" "Sends mail" "External"
    basket = softwareSystem "Basket" {
      webApp = container "Web app"
      basketApi = container "Basket API" "Serves baskets" "Node.js" {
        basketController = component "Basket controller" {
          properties {
            "bearing.path" "src/basket-api/basket-controller"
            "bearing.requirements" "#2"
          }
        }
        basketService = component "Basket service" {
          description "Adds, removes and persists basket items"
          tags "Service"
          properties {
            "bearing.path" "src/basket-api/basket-service"
            "bearing.requirements" "#1,#2,#4"
          }
        }
        basketRepository = component "Basket repository"
        component "Audit log"
      }
      db = container "Database" "" "Postgres"
    }
    shopper -> webApp "Uses"
    webApp -> basketController "Calls" "HTTPS"
    basketController -> basketService "addItem()"
    basketController -> basketService "removeItem()"
    basketService -> basketRepository "save()"
    basketRepository -> db "Reads from and writes to"
    basketService -> email "Sends receipts using"

    live = deploymentEnvironment "Live" {
      aws = deploymentNode "AWS" {
        ecs = deploymentNode "ECS" "" "Fargate" "" 2 {
          containerInstance basketApi
        }
        rds = deploymentNode "RDS" {
          containerInstance db
        }
        lb = infrastructureNode "Load balancer"
      }
      lb -> ecs "Forwards to"
    }
  }
  views {
    dynamic basketApi "req-2" "#2 Add an item to the basket" {
      webApp -> basketController "POST /basket/items"
      basketController -> basketService "addItem()"
      basketService -> basketRepository "save()"
    }
  }
}
