# B-11 Extract TypeScript imports into as-built relationships

**Milestone:** M1 MVP (TypeScript) · Build loop  
**Labels:** area:extractor  
**Depends on:** B-04

The core of `bearing derive`: map every file to a component by path, then turn cross-component imports into relationships.

- [ ] Resolves imports through `tsconfig` paths, barrels and re-exports
- [ ] Ignores imports inside one component
- [ ] Lists files that map to no component, for the surplus check
- [ ] Runs on a 50k-line repo in under 30 seconds (target to agree)
