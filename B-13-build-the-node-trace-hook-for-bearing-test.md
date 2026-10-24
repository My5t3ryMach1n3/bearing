# B-13 Build the Node trace hook for `bearing test`

**Milestone:** M1 MVP (TypeScript) · Build loop  
**Labels:** area:tracing  
**Depends on:** B-04

A module hook that wraps exported functions under each component path and emits OpenTelemetry spans tagged with the component, with no hand instrumentation.

- [ ] Works for both ESM and CommonJS
- [ ] Writes spans to `.bearing/traces/`, cleared at the start of each run
- [ ] Each span carries the test's criterion tag as an attribute
- [ ] Overhead measured on the fixture and one large open-source suite, and recorded in the README
