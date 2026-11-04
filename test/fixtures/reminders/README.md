# Reminders fixture

Chairside's reminder worker from the [worked example](https://claude.ai/code/artifact/4b47956a-6da1-4208-a2cf-df0dd14c2e04), cut down to one requirement, for the Go adapter ([#30](https://github.com/My5t3ryMach1n3/bearing/issues/30)). It plays the part the [basket fixture](../basket/README.md) plays for TypeScript: a Go repo with a known target, so the real checks can run on real traces.

| Path | What it is |
| --- | --- |
| `issues.json` | Requirement #3, "Remind patients before their appointment", with three criteria |
| `repo/` | The clean repo: what main looks like |
| `workspace.json` | `repo/architecture/workspace.dsl` as the pinned Structurizr exports it |
| `variants/<name>/` | Seeded branches, as files laid over `repo/` |

## The repo

- `architecture/workspace.dsl` is the approved target. It has four components in the reminder worker container, each with a `bearing.path` under `internal/`, and a dynamic view for #3: the consumer schedules each confirmed appointment, then the scheduler checks the store, sends through the SMS sender and marks the reminder sent.
- `internal/` has one package per component. The consumer polls a queue in a goroutine of its own, as the real worker does, so traces have to follow calls across goroutines.
- `integration/reminders_test.go` has one subtest per criterion, each named with its tag (`#3/AC1 …`). SQS and Twilio are fakes in the test file. `internal/sms/templates_test.go` has an untagged unit test and a skipped test, neither of which counts as evidence.
- `.bearing/config.yaml` lists one Go module at the repo root and runs `go test ./...`.

## Variants

Each variant is a branch that implements #3 and passes its own tests, with an honest claims file except where the claim is what's wrong.

| Variant | What it does | What should catch it |
| --- | --- | --- |
| `reminder-text` | Adds an opt-out line to each reminder | Nothing: every check passes |
| `consumer-sends-sms` | The consumer checks each phone number with the SMS sender itself. Its claim says nothing structural changed | Claim and Boundaries: an undeclared `eventConsumer -> smsSender`. Trace paths too, since the call shows up in #3's traces |
| `untraced-format` | Adds a Welsh template nothing calls | Surplus (advisory): `FormatWelsh` is never reached by a tagged test |

`copyReminders()` and `remindersRepo()` in [`test/reminders.ts`](../../reminders.ts) copy the repo, lay a variant over it and commit it on a branch. [`test/go.test.ts`](../../go.test.ts) runs `bearing test` and the checks on each.
