# B-14 Check criteria coverage from tagged tests

**Milestone:** M1 MVP (TypeScript) · Build loop  
**Labels:** area:checks  
**Depends on:** B-07, B-13

Every criterion of the issues a PR touches needs a tagged integration test that ran and passed in CI.

- [ ] Tag convention `#<issue>/AC<n>` in test names for the TypeScript runners we support (Vitest and Jest)
- [ ] Report lists each criterion as covered, missing or failing
- [ ] Untagged tests never count as trace evidence
