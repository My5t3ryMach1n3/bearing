### ⚠️ Target change

This PR changes the target, so merging it approves the change. Read this before the code.

Changed: `architecture/workspace.dsl`

- Removes the Basket sharing and Email outbox components from Basket API, and the external Email provider.
- Removed relationships: Basket controller → Basket sharing ("Shares baskets using"), Basket sharing → Basket service ("Reads the priced basket using"), Basket sharing → Email outbox ("Queues the email in"), Email outbox → Database ("Stores queued email in") and Email outbox → Email provider ("Sends queued email with, on a schedule").
- Removed dynamic view: #5.

#### System context: what changes

```mermaid
flowchart LR
  n0["Email provider<br/>[Software system]"]
  n1["Basket<br/>[Software system]"]
  n1 -.->|"Sends queued email with, on a schedule"| n0
  classDef removed fill:#f6f8fa,stroke:#8c959f,stroke-dasharray:4 3,color:#59636e
  class n0 removed
  linkStyle 0 stroke:#8c959f,stroke-width:2px
```

#### Containers: what changes

```mermaid
flowchart LR
  n0["Email provider<br/>[Software system]"]
  subgraph g0["Basket"]
    n1["Basket API<br/>[Container: TypeScript, Node.js]"]
  end
  n1 -.->|"Sends queued email with, on a schedule"| n0
  classDef removed fill:#f6f8fa,stroke:#8c959f,stroke-dasharray:4 3,color:#59636e
  class n0 removed
  linkStyle 0 stroke:#8c959f,stroke-width:2px
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
  n2 -.->|"Shares baskets using"| n0
  n0 -.->|"Reads the priced basket using"| n3
  n0 -.->|"Queues the email in"| n1
  n1 -.->|"Stores queued email in"| n4
  n1 -.->|"Sends queued email with, on a schedule"| n5
  classDef removed fill:#f6f8fa,stroke:#8c959f,stroke-dasharray:4 3,color:#59636e
  class n0,n1,n5 removed
  linkStyle 1,2,3,4,5 stroke:#8c959f,stroke-width:2px
```

Only what changes at each level and its neighbours. 🟩 added · ⬜ removed, dashed · 🟨 changed

#### Model diff

| | Added | Removed | Drifted |
| --- | --- | --- | --- |
| Elements |  | `basketSharing`, `emailOutbox`, `emailProvider` |  |
| Relationships |  | `basketController->basketSharing`, `basketSharing->basketService`, `basketSharing->emailOutbox`, `emailOutbox->database`, `emailOutbox->emailProvider` |  |
| Dynamic views |  | `req-5` |  |

19 elements and relationships no longer serve #5.

No ADR in this PR gives the reason for the change or the alternatives considered.