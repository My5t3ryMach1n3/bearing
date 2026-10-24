# B-23 Build the conformance job

**Milestone:** M1 MVP (TypeScript) · Change loop and GitHub Action  
**Labels:** area:action  
**Depends on:** B-16, B-17, B-19

Runs on `pull_request` with no secrets: validate, test, derive, check, report.

- [ ] Re-derives everything; never trusts committed as-built models, traces or results
- [ ] Sets `bearing/conformance` and `bearing/advisory`
- [ ] Comment posting works for fork PRs without secrets (approach decided in this issue)
- [ ] Published as a versioned Action
