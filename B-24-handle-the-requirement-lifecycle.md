# B-24 Handle the requirement lifecycle

**Milestone:** M1 MVP (TypeScript) · Change loop and GitHub Action  
**Labels:** area:requirements  
**Depends on:** B-07, B-20

Keep the target honest as issues change.

- [ ] Editing an issue's criteria flags affected dynamic views and tests as stale
- [ ] Closing as not planned lists elements that served only that issue for pruning, and flags their code as surplus
- [ ] `bearing validate` fails if an element lists a closed issue
