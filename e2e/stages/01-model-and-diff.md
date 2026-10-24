---
title: Load and diff Shelf's model
requires: [1, 2, 3, 4]
---
M0 is done: Bearing can load a config, run Structurizr and diff two models. Try it on Shelf before anything else exists.

- [ ] Install Bearing from a local build (`npm link` in the Bearing repo) and check `bearing --version` and `bearing --help`
- [ ] In Shelf, write `.bearing/config.yaml` by hand from the spec's Config example
- [ ] **Plant:** misspell one key in the config. The error should name the bad key
- [ ] Hand-write a rough `architecture/workspace.dsl` for shelf#1 to shelf#3 (an API container, a Postgres database, two or three components)
- [ ] Copy it, change one thing (rename a component's description, add one relationship), and diff the two. The rename must not read as a removed element; the relationship must show as added
- [ ] Run the diff twice in a row and check that the second run uses the cache and doesn't start Docker again
- [ ] Note how long the first Structurizr conversion took
