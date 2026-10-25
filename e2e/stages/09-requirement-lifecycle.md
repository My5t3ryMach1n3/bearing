---
title: New, edited and dropped requirements on Shelf
requires: [20, 24]
---
Two weeks on: requirements change under the target.

- [ ] File shelf#7 Reserve a book and run `bearing impact #7`. It should touch loans and the notifier from stage 7 and leave catalogue alone. Does it match your own guess?
- [ ] Have the agent propose the target diff from the impact output, accept it, then implement and merge
- [ ] Edit a criterion of shelf#4 (say, "due today" counts as overdue after 5pm). The affected dynamic view and tests should be flagged as stale
- [ ] Close shelf#5 Search by title as not planned. Elements that served only #5 should be listed for pruning, their code flagged as surplus, and `bearing validate` should fail until the model drops them
- [ ] Prune it through a PR
