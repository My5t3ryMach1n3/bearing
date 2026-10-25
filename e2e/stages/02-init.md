---
title: Run bearing init on Shelf
requires: [6]
---
- [ ] Delete the hand-written config and DSL from stage 1, then run `bearing init` in Shelf on a branch
- [ ] Check it wrote `architecture/`, `.bearing/config.yaml`, `.bearing/claims/`, the issue form, and both workflows, wrote no CODEOWNERS (none was asked for), and added `.bearing/traces/` to `.gitignore`
- [ ] Add a line of your own to `AGENTS.md` and to the config, run `bearing init` again, and confirm neither was overwritten
- [ ] Turn on every repo setting it prints (branch protection, required checks) and note any that were unclear
- [ ] Merge through a PR
