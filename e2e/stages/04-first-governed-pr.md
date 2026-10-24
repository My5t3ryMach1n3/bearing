---
title: First governed PRs on Shelf
requires: [11, 12, 13, 14, 15, 16]
---
The build loop, run locally with `bearing check`. CI comes in stage 6.

- [ ] Have the agent add minimal Terraform under `infra/` matching the deployment view (ECS service and RDS instance). It is only parsed, never applied
- [ ] Have the agent implement shelf#1 and shelf#2 following `AGENTS.md`: `bearing context #<n>` first, tests tagged `#2/AC1` and so on, then `bearing claim`, `bearing test`, `bearing check`. All green?
- [ ] **Plant (Boundaries, Claim):** on a branch, make the borrow endpoint's controller import the repository directly, and leave the claims file saying no structural change. Both checks should fail, and only those
- [ ] **Plant (Criteria coverage):** delete the test tagged `#2/AC2`. Coverage should list it as missing
- [ ] **Plant (Claim):** add a file to a component and leave it out of the claims file
- [ ] Is each failure message enough for the agent to fix it without help? Let the agent self-heal one of them and count the attempts
- [ ] Implement shelf#3 for real and merge it
