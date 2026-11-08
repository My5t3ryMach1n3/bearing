### ⚠️ Target change

This PR changes the target, so merging it approves the change. Read this before the code.

Changed: `architecture/workspace.dsl`

This is the initial target. It defines 1 person, 3 software systems, 3 containers, 5 components and 6 dynamic views.

#### System context

```mermaid
flowchart LR
  n0["Shopper<br/>[Person]"]
  n1["Identity provider<br/>[Software system]"]
  n2["Product catalogue<br/>[Software system]"]
  n3["Basket<br/>[Software system]"]
  n0 -->|"Fills their basket using"| n3
  n0 -->|"Signs in using"| n1
  n3 -->|"Introspects tokens with"| n1
  n3 -->|"Looks up products and prices in"| n2
```

#### Containers

```mermaid
flowchart LR
  n0["Shopper<br/>[Person]"]
  n1["Identity provider<br/>[Software system]"]
  n2["Product catalogue<br/>[Software system]"]
  subgraph g0["Basket"]
    n3["Web app<br/>[Container: TypeScript, React]"]
    n4["Basket API<br/>[Container: TypeScript, Node.js]"]
    n5["Database<br/>[Container: PostgreSQL]"]
  end
  n0 -->|"Fills their basket using"| n3
  n0 -->|"Signs in using"| n1
  n3 -->|"Makes API calls to"| n4
  n4 -->|"Introspects tokens with"| n1
  n4 -->|"Looks up products and prices in"| n2
  n4 -->|"Reads from and writes to"| n5
```

#### Components of Basket API

```mermaid
flowchart LR
  subgraph g0["Basket API"]
    n0["Auth middleware<br/>[Component]"]
    n1["Basket controller<br/>[Component]"]
    n2["Basket service<br/>[Component]"]
    n3["Basket repository<br/>[Component]"]
    n4["Session restore<br/>[Component]"]
  end
  n5["Web app<br/>[Container: TypeScript, React]"]
  n6["Identity provider<br/>[Software system]"]
  n7["Product catalogue<br/>[Software system]"]
  n8["Database<br/>[Container: PostgreSQL]"]
  n5 -->|"Makes API calls to"| n1
  n0 -->|"Introspects tokens with"| n6
  n1 -->|"Authenticates requests using"| n0
  n1 -->|"Reads and changes baskets using"| n2
  n1 -->|"Restores saved baskets using"| n4
  n2 -->|"Loads and saves baskets using"| n3
  n2 -->|"Looks up products and prices in"| n7
  n3 -->|"Reads from and writes to"| n8
  n4 -->|"Checks the new sign-in using"| n0
  n4 -->|"Loads saved baskets from"| n3
```

#### Deployment: Production

```mermaid
flowchart LR
  subgraph g0["Amazon Web Services"]
    n0["CDN<br/>[Infrastructure node: Amazon CloudFront]"]
  end
  subgraph g1["eu-west-2"]
    n1["Load balancer<br/>[Infrastructure node: Application Load Balancer]"]
  end
  subgraph g2["Static site"]
    n2["Web app<br/>[Container instance]"]
  end
  subgraph g3["ECS service"]
    n3["Basket API<br/>[Container instance]"]
  end
  subgraph g4["RDS"]
    n4["Database<br/>[Container instance]"]
  end
```

#### Dynamic views

<details><summary>#1 View the basket</summary>

```mermaid
sequenceDiagram
  autonumber
  participant p0 as Web app
  participant p1 as Basket controller
  participant p2 as Auth middleware
  participant p3 as Identity provider
  participant p4 as Basket service
  participant p5 as Basket repository
  participant p6 as Database
  participant p7 as Product catalogue
  p0->>p1: GET /basket
  p1->>p2: authenticate()
  p2->>p3: Introspects the token
  p1->>p4: getBasket()
  p4->>p5: loadBasket()
  p5->>p6: Selects the basket
  p4->>p7: Looks up current prices
```

</details>

<details><summary>#2 Add an item to the basket</summary>

```mermaid
sequenceDiagram
  autonumber
  participant p0 as Web app
  participant p1 as Basket controller
  participant p2 as Auth middleware
  participant p3 as Identity provider
  participant p4 as Basket service
  participant p5 as Product catalogue
  participant p6 as Basket repository
  participant p7 as Database
  p0->>p1: POST /basket/items
  p1->>p2: authenticate()
  p2->>p3: Introspects the token
  p1->>p4: addItem()
  p4->>p5: Checks the product exists
  p4->>p6: loadBasket(), saveBasket()
  p6->>p7: Selects and upserts the basket
```

</details>

<details><summary>#3 Remove an item from the basket</summary>

```mermaid
sequenceDiagram
  autonumber
  participant p0 as Web app
  participant p1 as Basket controller
  participant p2 as Auth middleware
  participant p3 as Identity provider
  participant p4 as Basket service
  participant p5 as Basket repository
  participant p6 as Database
  p0->>p1: DELETE /basket/items/{sku}
  p1->>p2: authenticate()
  p2->>p3: Introspects the token
  p1->>p4: removeItem()
  p4->>p5: loadBasket(), saveBasket()
  p5->>p6: Selects and upserts the basket
```

</details>

<details><summary>#4 Restore the basket after the session expires</summary>

```mermaid
sequenceDiagram
  autonumber
  participant p0 as Web app
  participant p1 as Basket controller
  participant p2 as Session restore
  participant p3 as Auth middleware
  participant p4 as Identity provider
  participant p5 as Basket repository
  participant p6 as Database
  p0->>p1: POST /session/restore
  p1->>p2: restoreSession()
  p2->>p3: authenticate()
  p3->>p4: Introspects the new token
  p2->>p5: loadBasket()
  p5->>p6: Selects the saved basket
```

</details>

<details><summary>#6 Change an item's quantity</summary>

```mermaid
sequenceDiagram
  autonumber
  participant p0 as Web app
  participant p1 as Basket controller
  participant p2 as Auth middleware
  participant p3 as Identity provider
  participant p4 as Basket service
  participant p5 as Basket repository
  participant p6 as Database
  p0->>p1: PATCH /basket/items/{sku}
  p1->>p2: authenticate()
  p2->>p3: Introspects the token
  p1->>p4: setQuantity()
  p4->>p5: loadBasket(), saveBasket()
  p5->>p6: Selects and upserts the basket
```

</details>

<details><summary>#7 Empty the basket</summary>

```mermaid
sequenceDiagram
  autonumber
  participant p0 as Web app
  participant p1 as Basket controller
  participant p2 as Auth middleware
  participant p3 as Identity provider
  participant p4 as Basket service
  participant p5 as Basket repository
  participant p6 as Database
  p0->>p1: DELETE /basket
  p1->>p2: authenticate()
  p2->>p3: Introspects the token
  p1->>p4: clearBasket()
  p4->>p5: saveBasket()
  p5->>p6: Upserts the empty basket
```

</details>

<details><summary>Model diff</summary>

| | Added | Removed | Drifted |
| --- | --- | --- | --- |
| Elements | `authMiddleware`, `basket`, `basketApi`, `basketController`, `basketRepository`, `basketService`, `database`, `identityProvider`, `productCatalogue`, `sessionRestore`, `shopper`, `webApp` |  |  |
| Relationships | `authMiddleware->identityProvider`, `basketController->authMiddleware`, `basketController->basketService`, `basketController->sessionRestore`, `basketRepository->database`, `basketService->basketRepository`, `basketService->productCatalogue`, `cdn->site`, `lb->ecs`, `sessionRestore->authMiddleware`, `sessionRestore->basketRepository`, `shopper->identityProvider`, `shopper->webApp`, `webApp->basketController` |  |  |
| Dynamic views | `req-1`, `req-2`, `req-3`, `req-4`, `req-6`, `req-7` |  |  |
| Deployment | `aws`, `cdn`, `ecs`, `ecs/basketApi`, `lb`, `rds`, `rds/database`, `region`, `site`, `site/webApp` |  |  |

</details>

No ADR in this PR gives the reason for the change or the alternatives considered.