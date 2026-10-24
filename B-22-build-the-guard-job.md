# B-22 Build the guard job

**Milestone:** M1 MVP (TypeScript) · Change loop and GitHub Action  
**Labels:** area:action  
**Depends on:** B-01

Runs on `pull_request_target` from the base branch and never executes PR code.

- [ ] Reads changed paths through the API only
- [ ] Changes under `architecture/`, `.bearing/` or `.github/workflows/` add the `architecture-change` label and hold `bearing/target` pending until code-owner approval
- [ ] A test PR that edits the workflow cannot turn the guard off
