# B-10 Ship the AGENTS.md section and design skill

**Milestone:** M1 MVP (TypeScript) · Design loop  
**Labels:** area:agent  
**Depends on:** B-08, B-09

The instructions any coding agent follows to design a target and to code within it. Bearing itself never calls an LLM.

- [ ] AGENTS.md section from the spec, with the self-heal attempt count read from config
- [ ] A requirements-to-model skill that drafts levels 1 to 3, one dynamic view per issue, deployment views and component paths
- [ ] ADR template under `architecture/adrs/`
- [ ] Tried on the basket fixture's six issues: the draft passes `bearing validate`
