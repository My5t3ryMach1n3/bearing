### ⚠️ Target change

This PR changes the target, so merging it approves the change. Read this before the code.

Changed: `architecture/workspace.dsl`

- Changes Session restore (description).
- Changed relationship: Session restore → Basket repository ("Loads, merges and saves baskets using").
- New dynamic view: #20.

#### Components: what changes in Basket API

```mermaid
flowchart LR
  subgraph g0["Basket API"]
    n0["Session restore<br/>[Component]"]
    n1["Basket repository<br/>[Component]"]
    n2["Basket controller<br/>[Component]"]
    n3["Auth middleware<br/>[Component]"]
  end
  n2 -->|"Authenticates requests using"| n3
  n2 -->|"Restores saved baskets using"| n0
  n0 -->|"Checks the new sign-in using"| n3
  n0 -->|"Loads, merges and saves baskets using"| n1
  classDef changed fill:#fff8c5,stroke:#9a6700,color:#1f2328
  class n0 changed
  linkStyle 3 stroke:#9a6700,stroke-width:2px
```

Only what changes at each level and its neighbours. 🟩 added · ⬜ removed, dashed · 🟨 changed

#### Dynamic views

<details open><summary>#20 Fill a basket as a guest</summary>

```mermaid
sequenceDiagram
  autonumber
  participant p0 as Web app
  participant p1 as Basket controller
  participant p2 as Basket service
  participant p3 as Product catalogue
  participant p4 as Basket repository
  participant p5 as Database
  participant p6 as Session restore
  participant p7 as Auth middleware
  participant p8 as Identity provider
  p0->>p1: POST /basket/items, GET /basket with a guest session
  p1->>p2: addItem(), getBasket()
  p2->>p3: Checks and prices the products
  p2->>p4: loadBasket(), saveBasket()
  p4->>p5: Selects and upserts the guest basket
  p0->>p1: POST /session/restore with the guest session
  p1->>p6: restoreSession()
  p6->>p7: authenticate()
  p7->>p8: Introspects the token
  p6->>p4: loadBasket() for both, saveBasket() merged
  p4->>p5: Selects both baskets and upserts the merged one
```

</details>

#### Model diff

| | Added | Removed | Drifted |
| --- | --- | --- | --- |
| Elements |  |  | `sessionRestore` (description) |
| Relationships |  |  | `sessionRestore->basketRepository` (description) |
| Dynamic views | `req-20` |  |  |

21 elements and relationships now also serve #20.

No ADR in this PR gives the reason for the change or the alternatives considered.