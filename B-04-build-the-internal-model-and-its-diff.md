# B-04 Build the internal model and its diff

**Milestone:** M0 Foundations  
**Labels:** area:model  
**Depends on:** B-03

One in-memory model shared by target, as-built and claims: elements, relationships, dynamic views and deployment nodes, each with stable IDs and its `bearing.path` and `bearing.requirements` properties.

- [ ] Loader from workspace JSON into the internal model
- [ ] Diff of two models into added, removed and drifted elements and relationships
- [ ] Stable IDs so a renamed description doesn't read as a removed element
- [ ] Diff output in JSON for other commands to consume
