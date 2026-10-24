# B-17 Check trace paths against dynamic views

**Milestone:** M1 MVP (TypeScript) · Build loop  
**Labels:** area:checks  
**Depends on:** B-13, B-16

Compare each tagged test's observed component path with its issue's dynamic view.

- [ ] A view matches when its steps appear in order in the trace with no undeclared component in between (the worked example's subsequence rule)
- [ ] Failure output shows the expected and observed paths side by side
- [ ] Passes on the fixture's #2, fails on a seeded wrong-place branch
