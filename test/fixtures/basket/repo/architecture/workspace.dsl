workspace "Basket" "The approved target for the basket service in the spec's walkthrough." {
  model {
    shopper = person "Shopper" "Someone filling a basket to check out later" {
      properties {
        "bearing.requirements" "#1,#2,#3,#4,#6,#7"
      }
    }

    identityProvider = softwareSystem "Identity provider" "Signs shoppers in and vouches for their tokens" {
      tags "External"
      properties {
        "bearing.requirements" "#1,#2,#3,#4,#6,#7"
      }
    }
    productCatalogue = softwareSystem "Product catalogue" "Names and prices every product on sale" {
      tags "External"
      properties {
        "bearing.requirements" "#1,#2"
      }
    }

    basket = softwareSystem "Basket" "Keeps each shopper's basket until they check out" {
      properties {
        "bearing.requirements" "#1,#2,#3,#4,#6,#7"
      }

      webApp = container "Web app" "The shop front shoppers browse and fill their basket in" "TypeScript, React" {
        properties {
          "bearing.requirements" "#1,#2,#3,#4,#6,#7"
        }
      }

      basketApi = container "Basket API" "Reads and changes baskets on behalf of the web app" "TypeScript, Node.js" {
        properties {
          "bearing.requirements" "#1,#2,#3,#4,#6,#7"
        }

        authMiddleware = component "Auth middleware" {
          description "Checks every request's token with the identity provider"
          properties {
            "bearing.path" "src/basket-api/auth-middleware"
            "bearing.requirements" "#1,#2,#3,#4,#6,#7"
          }
        }
        basketController = component "Basket controller" {
          description "Routes basket API requests and maps errors to HTTP responses"
          properties {
            "bearing.path" "src/basket-api/basket-controller"
            "bearing.requirements" "#1,#2,#3,#4,#6,#7"
          }
        }
        basketService = component "Basket service" {
          description "Adds, removes, prices and persists basket items"
          properties {
            "bearing.path" "src/basket-api/basket-service"
            "bearing.requirements" "#1,#2,#3,#6,#7"
          }
        }
        basketRepository = component "Basket repository" {
          description "Loads and saves each shopper's basket in Postgres"
          properties {
            "bearing.path" "src/basket-api/basket-repository"
            "bearing.requirements" "#1,#2,#3,#4,#6,#7"
          }
        }
        sessionRestore = component "Session restore" {
          description "Hands a shopper back their saved basket when they sign in after their session expired"
          properties {
            "bearing.path" "src/basket-api/session-restore"
            "bearing.requirements" "#4"
          }
        }
      }

      database = container "Database" "One row per shopper holding their saved basket" "PostgreSQL" {
        tags "Database"
        properties {
          "bearing.requirements" "#1,#2,#3,#4,#6,#7"
        }
      }
    }

    shopper -> webApp "Fills their basket using" {
      properties {
        "bearing.requirements" "#1,#2,#3,#4,#6,#7"
      }
    }
    shopper -> identityProvider "Signs in using" {
      properties {
        "bearing.requirements" "#1,#2,#3,#4,#6,#7"
      }
    }
    webApp -> basketController "Makes API calls to" "JSON/HTTPS" {
      properties {
        "bearing.requirements" "#1,#2,#3,#4,#6,#7"
      }
    }
    basketController -> authMiddleware "Authenticates requests using" {
      properties {
        "bearing.requirements" "#1,#2,#3,#6,#7"
      }
    }
    basketController -> basketService "Reads and changes baskets using" {
      properties {
        "bearing.requirements" "#1,#2,#3,#6,#7"
      }
    }
    basketController -> sessionRestore "Restores saved baskets using" {
      properties {
        "bearing.requirements" "#4"
      }
    }
    sessionRestore -> authMiddleware "Checks the new sign-in using" {
      properties {
        "bearing.requirements" "#4"
      }
    }
    sessionRestore -> basketRepository "Loads saved baskets from" {
      properties {
        "bearing.requirements" "#4"
      }
    }
    authMiddleware -> identityProvider "Introspects tokens with" "OAuth 2.0/HTTPS" {
      properties {
        "bearing.requirements" "#1,#2,#3,#4,#6,#7"
      }
    }
    basketService -> basketRepository "Loads and saves baskets using" {
      properties {
        "bearing.requirements" "#1,#2,#3,#6,#7"
      }
    }
    basketService -> productCatalogue "Looks up products and prices in" "JSON/HTTPS" {
      properties {
        "bearing.requirements" "#1,#2"
      }
    }
    basketRepository -> database "Reads from and writes to" "SQL" {
      properties {
        "bearing.requirements" "#1,#2,#3,#4,#6,#7"
      }
    }

    production = deploymentEnvironment "Production" {
      aws = deploymentNode "Amazon Web Services" {
        cdn = infrastructureNode "CDN" "Serves the web app to shoppers" "Amazon CloudFront"
        region = deploymentNode "eu-west-2" {
          site = deploymentNode "Static site" "" "Amazon S3" {
            containerInstance webApp
          }
          lb = infrastructureNode "Load balancer" "Terminates HTTPS for the basket API" "Application Load Balancer"
          ecs = deploymentNode "ECS service" "" "AWS Fargate" "" 2 {
            containerInstance basketApi
          }
          rds = deploymentNode "RDS" "" "Amazon RDS for PostgreSQL 16" {
            containerInstance database
          }
        }
      }
      cdn -> site "Serves files from" "HTTPS"
      lb -> ecs "Forwards requests to" "HTTPS"
    }
  }

  views {
    systemContext basket "context" {
      include *
      autoLayout
    }
    container basket "containers" {
      include *
      autoLayout
    }
    component basketApi "components" {
      include *
      autoLayout
    }

    dynamic basketApi "req-1" "#1 View the basket" {
      webApp -> basketController "GET /basket"
      basketController -> authMiddleware "authenticate()"
      authMiddleware -> identityProvider "Introspects the token"
      basketController -> basketService "getBasket()"
      basketService -> basketRepository "loadBasket()"
      basketRepository -> database "Selects the basket"
      basketService -> productCatalogue "Looks up current prices"
      autoLayout
      properties {
        "bearing.criteria" "AC1:886264ca,AC2:dcbb7ce8"
      }
    }
    dynamic basketApi "req-2" "#2 Add an item to the basket" {
      webApp -> basketController "POST /basket/items"
      basketController -> authMiddleware "authenticate()"
      authMiddleware -> identityProvider "Introspects the token"
      basketController -> basketService "addItem()"
      basketService -> productCatalogue "Checks the product exists"
      basketService -> basketRepository "loadBasket(), saveBasket()"
      basketRepository -> database "Selects and upserts the basket"
      autoLayout
      properties {
        "bearing.criteria" "AC1:e665a9d6,AC2:e984cf88"
      }
    }
    dynamic basketApi "req-3" "#3 Remove an item from the basket" {
      webApp -> basketController "DELETE /basket/items/{sku}"
      basketController -> authMiddleware "authenticate()"
      authMiddleware -> identityProvider "Introspects the token"
      basketController -> basketService "removeItem()"
      basketService -> basketRepository "loadBasket(), saveBasket()"
      basketRepository -> database "Selects and upserts the basket"
      autoLayout
      properties {
        "bearing.criteria" "AC1:2bc23bfd,AC2:ecdaf7cc"
      }
    }
    dynamic basketApi "req-4" "#4 Restore the basket after the session expires" {
      webApp -> basketController "POST /session/restore"
      basketController -> sessionRestore "restoreSession()"
      sessionRestore -> authMiddleware "authenticate()"
      authMiddleware -> identityProvider "Introspects the new token"
      sessionRestore -> basketRepository "loadBasket()"
      basketRepository -> database "Selects the saved basket"
      autoLayout
      properties {
        "bearing.criteria" "AC1:c417b1ba,AC2:076fcca2"
      }
    }
    dynamic basketApi "req-6" "#6 Change an item's quantity" {
      webApp -> basketController "PATCH /basket/items/{sku}"
      basketController -> authMiddleware "authenticate()"
      authMiddleware -> identityProvider "Introspects the token"
      basketController -> basketService "setQuantity()"
      basketService -> basketRepository "loadBasket(), saveBasket()"
      basketRepository -> database "Selects and upserts the basket"
      autoLayout
      properties {
        "bearing.criteria" "AC1:048afb29,AC2:ab3d5213"
      }
    }
    dynamic basketApi "req-7" "#7 Empty the basket" {
      webApp -> basketController "DELETE /basket"
      basketController -> authMiddleware "authenticate()"
      authMiddleware -> identityProvider "Introspects the token"
      basketController -> basketService "clearBasket()"
      basketService -> basketRepository "saveBasket()"
      basketRepository -> database "Upserts the empty basket"
      autoLayout
      properties {
        "bearing.criteria" "AC1:d4f93295"
      }
    }

    deployment basket production "deployment" {
      include *
      autoLayout
    }

    styles {
      element "External" {
        background #999999
      }
      element "Database" {
        shape cylinder
      }
    }
  }
}
