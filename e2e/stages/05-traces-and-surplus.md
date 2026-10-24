---
title: Trace paths and surplus code on Shelf
requires: [17, 18]
---
- [ ] Have the agent implement shelf#4. Tests for overdue loans need an injectable clock: check the agent finds the convention in `AGENTS.md`
- [ ] Check the trace from `#4/AC1` matches shelf#4's dynamic view
- [ ] **Plant (Trace paths):** on a branch, compute days-overdue in a different component from the one the dynamic view names, through relationships the target already declares. Boundaries passes; the trace path check must fail and show expected and observed paths side by side
- [ ] **Plant (Surplus):** add an exported `formatIsbn` helper inside a component that no test ever calls. It should be flagged as advisory and not block
- [ ] Implement shelf#5 and merge it
