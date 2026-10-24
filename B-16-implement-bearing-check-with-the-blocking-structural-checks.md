# B-16 Implement `bearing check` with the blocking structural checks

**Milestone:** M1 MVP (TypeScript) · Build loop  
**Labels:** area:checks  
**Depends on:** B-09, B-11, B-12, B-14, B-15

Run Claim, Boundaries, Deployment and Criteria coverage, and exit non-zero on any blocking failure.

- [ ] Claim: claims file versus as-built, listing each mismatch
- [ ] Boundaries: any relationship between components that the target doesn't declare fails; anything inside a component passes
- [ ] Deployment: Terraform versus target deployment view
- [ ] Machine-readable result for `bearing report`
- [ ] Each seeded fixture branch fails the right check and only that check
