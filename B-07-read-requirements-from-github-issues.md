# B-07 Read requirements from GitHub Issues

**Milestone:** M1 MVP (TypeScript) · Design loop  
**Labels:** area:requirements  
**Depends on:** B-02

Treat issues labelled `requirement` as the source of truth, with the issue number as the stable ID.

- [ ] Issue form (`requirement.yml`) with Story and numbered Given/When/Then criteria
- [ ] Parser that returns each issue's story and criteria as `#<n>/AC<k>`, and rejects malformed criteria with a clear message
- [ ] Epics as parent issues; only leaf stories are returned as needing a dynamic view
- [ ] Works with a token in CI and with `gh` auth locally; fixture mode for tests
