# B-18 Flag surplus code

**Milestone:** M1 MVP (TypeScript) · Build loop  
**Labels:** area:checks  
**Depends on:** B-11, B-13

Advisory only: code outside any component path, or never reached by any criterion's trace.

- [ ] Reports files and exported functions, not lines
- [ ] Never blocks merge; sets the `bearing/advisory` status
- [ ] The fixture's `retryWithBackoff` helper is flagged
