# B-29 Spike: trace Go without hand instrumentation

**Milestone:** M2 Language adapters  
**Labels:** area:lang type:spike  
**Depends on:** B-26

Go can't be patched at runtime. Compare generated wrappers with `go build -toolexec` rewriting and pick one.

- [ ] Both approaches prototyped on the Chairside reminder worker
- [ ] Build time and test overhead measured for each
- [ ] Decision recorded as an ADR in the Bearing repo
