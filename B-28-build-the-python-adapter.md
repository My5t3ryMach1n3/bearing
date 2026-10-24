# B-28 Build the Python adapter

**Milestone:** M2 Language adapters  
**Labels:** area:lang  
**Depends on:** B-26

- [ ] Import extractor over packages and relative imports, honouring `pyproject.toml` source roots
- [ ] Trace hook that wraps functions under component paths at import time, no code edits
- [ ] Tag carrier: a pytest marker carrying `#<issue>/AC<n>`
- [ ] Chairside booking API (FastAPI) passes all checks
