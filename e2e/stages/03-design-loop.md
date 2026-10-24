---
title: Design Shelf's target architecture
requires: [7, 8, 9, 10]
---
The design loop: requirements in, reviewed target out.

- [ ] Re-file one of shelf#1 to shelf#5 through the new `requirement` issue form, to check the form and the hand-written ones parse the same way
- [ ] Run `bearing context --issues` and read it as the agent would. Is anything missing or noisy?
- [ ] Ask your coding agent to design the target from the open requirements, following `AGENTS.md`. Ask for a deployment view with the API on ECS and Postgres on RDS
- [ ] Check the draft passes `bearing validate`, then **Plant:** add an element that lists no requirement. Validate must fail
- [ ] Review the model in Structurizr one dynamic view at a time. Push back on at least one thing through PR review comments and let the agent revise
- [ ] Record one choice as an ADR from the template
- [ ] Approve and merge. That commit is Shelf's target
