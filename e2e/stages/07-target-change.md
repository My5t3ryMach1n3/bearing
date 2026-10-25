---
title: Propose a target change for reminder emails
requires: [21, 22]
---
The target is wrong for a new requirement, so the agent has to propose a change.

- [ ] File shelf#6 Overdue reminder email from the scenario README
- [ ] Have the agent implement it within the current target. It should fail, run out of self-heal attempts, and propose a model change in the same branch: a notifier component, an external email provider and the relationship between them, with reason and alternatives
- [ ] Check the PR flips into target-change mode: labelled, model diff first, and `bearing/target` held until you, as Shelf's only code owner, release it
- [ ] Review it as code owner and ask for the email call to be asynchronous (criterion 2 needs it anyway). The agent updates model and code together
- [ ] Before merging, open a second, small model-changing PR from main. Merge one, then check the other fails until it's rebased onto the new target
- [ ] Release `bearing/target` and merge shelf#6 yourself; you don't need anyone else's approval
