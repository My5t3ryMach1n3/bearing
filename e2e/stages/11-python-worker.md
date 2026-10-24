---
title: Move Shelf's reminders to a Python worker
requires: [26, 27, 28]
---
Shelf goes multi-language: reminders move out of the API into a Python worker fed by a queue.

- [ ] Switch Shelf's config to the `languages` list with the existing TypeScript root. Check results are unchanged
- [ ] Have the agent propose the target change: the API publishes loan events to an SQS queue, and a new Python reminder worker consumes them and sends the emails
- [ ] Add the queue and the worker's task role and IAM policy to `infra/`. The `publisher -> queue -> worker` relationship should be derived from Terraform
- [ ] Tag the worker's pytest tests and check one test yields one trace across the queue, matching shelf#6's dynamic view
- [ ] **Plant (Boundaries):** have the worker read the loans table directly instead of using the event payload. Boundaries must fail
- [ ] Merge the move
