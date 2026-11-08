### ⚠️ Target change

This PR changes the target, so merging it approves the change. Read this before the code.

Changed: `architecture/workspace.dsl`

- Adds the Basket sharing and Email outbox components to Basket API, and the external Email provider.
- New relationships: Basket controller → Basket sharing ("Shares baskets using"), Basket sharing → Basket service ("Reads the priced basket using"), Basket sharing → Email outbox ("Queues the email in"), Email outbox → Database ("Stores queued email in") and Email outbox → Email provider ("Sends queued email with, on a schedule").
- New dynamic view: #5.

#### System context: what changes

```mermaid
flowchart LR
  n0["Email provider<br/>[Software system]"]
  n1["Basket<br/>[Software system]"]
  n1 -->|"Sends queued email with, on a schedule"| n0
  classDef added fill:#dafbe1,stroke:#1a7f37,color:#1f2328
  class n0 added
  linkStyle 0 stroke:#1a7f37,stroke-width:2px
```

#### Containers: what changes

```mermaid
flowchart LR
  n0["Email provider<br/>[Software system]"]
  subgraph g0["Basket"]
    n1["Basket API<br/>[Container: TypeScript, Node.js]"]
  end
  n1 -->|"Sends queued email with, on a schedule"| n0
  classDef added fill:#dafbe1,stroke:#1a7f37,color:#1f2328
  class n0 added
  linkStyle 0 stroke:#1a7f37,stroke-width:2px
```

#### Components: what changes in Basket API

```mermaid
flowchart LR
  subgraph g0["Basket API"]
    n0["Basket sharing<br/>[Component]"]
    n1["Email outbox<br/>[Component]"]
    n2["Basket controller<br/>[Component]"]
    n3["Basket service<br/>[Component]"]
  end
  n4["Database<br/>[Container: PostgreSQL]"]
  n5["Email provider<br/>[Software system]"]
  n2 -->|"Reads and changes baskets using"| n3
  n2 -->|"Shares baskets using"| n0
  n0 -->|"Reads the priced basket using"| n3
  n0 -->|"Queues the email in"| n1
  n1 -->|"Stores queued email in"| n4
  n1 -->|"Sends queued email with, on a schedule"| n5
  classDef added fill:#dafbe1,stroke:#1a7f37,color:#1f2328
  class n0,n1,n5 added
  linkStyle 1,2,3,4,5 stroke:#1a7f37,stroke-width:2px
```

Only what changes at each level and its neighbours. 🟩 added · ⬜ removed, dashed · 🟨 changed

#### Dynamic views

<details open><summary>#5 Share the basket by email</summary>

```mermaid
sequenceDiagram
  autonumber
  participant p0 as Web app
  participant p1 as Basket controller
  participant p2 as Auth middleware
  participant p3 as Identity provider
  participant p4 as Basket sharing
  participant p5 as Basket service
  participant p6 as Basket repository
  participant p7 as Database
  participant p8 as Product catalogue
  participant p9 as Email outbox
  participant p10 as Email provider
  p0->>p1: POST /basket/share
  p1->>p2: authenticate()
  p2->>p3: Introspects the token
  p1->>p4: shareBasket()
  p4->>p5: getBasket()
  p5->>p6: loadBasket()
  p6->>p7: Selects the basket
  p5->>p8: Looks up current prices
  p4->>p9: queueEmail()
  p9->>p7: Inserts the email
  p9->>p10: Sends it later, from sendPendingEmails()
```

</details>

#### Model diff

| | Added | Removed | Drifted |
| --- | --- | --- | --- |
| Elements | `basketSharing`, `emailOutbox`, `emailProvider` |  |  |
| Relationships | `basketController->basketSharing`, `basketSharing->basketService`, `basketSharing->emailOutbox`, `emailOutbox->database`, `emailOutbox->emailProvider` |  |  |
| Dynamic views | `req-5` |  |  |

19 elements and relationships now also serve #5.

No ADR in this PR gives the reason for the change or the alternatives considered.