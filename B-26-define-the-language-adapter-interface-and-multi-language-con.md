# B-26 Define the language adapter interface and multi-language config

**Milestone:** M2 Language adapters  
**Labels:** area:lang  
**Depends on:** B-25

Move TypeScript onto a pluggable adapter and let one repo hold several languages.

- [ ] Adapter interface: `extractImports`, `traceHook`, `tagCarrier`
- [ ] TypeScript reimplemented as the first adapter with no change in check results on the fixture
- [ ] Config gains a `languages` list, each with a root folder and its project file; `language:` still works
- [ ] Contributor guide for writing a new adapter
