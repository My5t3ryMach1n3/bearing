---
title: "Optional: rewrite Shelf's worker in Go"
requires: [30]
---
Only if you want to exercise the Go adapter on something other than Chairside.

- [ ] Rewrite the reminder worker in Go behind the same queue, with no model change apart from the container's technology
- [ ] Tag subtests with `#6/AC1` and check traces match without hand instrumentation
- [ ] Note the build and test overhead next to the numbers from the [#29](https://github.com/My5t3ryMach1n3/bearing/issues/29) spike
