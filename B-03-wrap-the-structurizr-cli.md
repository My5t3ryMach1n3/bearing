# B-03 Wrap the Structurizr CLI

**Milestone:** M0 Foundations  
**Labels:** area:model  
**Depends on:** B-02

Call the Structurizr CLI once, via Docker or Java, to turn `workspace.dsl` into workspace JSON. Everything after this runs in TypeScript.

- [ ] Runner chosen by `structurizr.runner`, with a pinned image or jar version
- [ ] Structurizr validation errors surface with file and line
- [ ] Workspace JSON is cached by DSL hash so repeated commands don't re-run Docker
- [ ] CI time for one conversion measured and recorded
