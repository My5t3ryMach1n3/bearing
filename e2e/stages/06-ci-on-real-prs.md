---
title: Run Bearing in CI on Shelf's PRs
requires: [19, 22, 23]
---
The same loop, now enforced by the Action on real PRs.

- [ ] Point Shelf's workflows at the published Action and make `bearing/target` and `bearing/conformance` required checks
- [ ] Reopen one of the stage 4 or 5 planted branches as a PR. The PR comment should give a summary first, then one readable overlay with the bad relationship in colour
- [ ] Push a fix to that PR and check the comment is updated in place, not duplicated
- [ ] **Plant (guard):** open a PR that edits `.github/workflows/bearing-guard.yml` to skip itself. The guard must still run from main, label the PR `architecture-change` and hold `bearing/target`
- [ ] Open the Structurizr export linked from the comment
