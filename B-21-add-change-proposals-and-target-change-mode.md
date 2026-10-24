# B-21 Add change proposals and target-change mode

**Milestone:** M1 MVP (TypeScript) · Change loop and GitHub Action  
**Labels:** area:checks  
**Depends on:** B-16, B-19

When a PR edits model files, compare against the PR's proposed target, and make the model diff the first thing a reviewer sees.

- [ ] Change proposal template: target diff, reason, alternatives considered
- [ ] Checks use the proposed target when `architecture/` changed, main's target otherwise
- [ ] First merged wins: a later proposal fails until rebased onto the new target
