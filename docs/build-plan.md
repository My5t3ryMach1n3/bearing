# Bearing build plan

The work itself is tracked as [GitHub issues](https://github.com/My5t3ryMach1n3/bearing/issues) grouped into [milestones](https://github.com/My5t3ryMach1n3/bearing/milestones). This page is the overview: how the plan is shaped, how the issues sequence, and the open questions they settle.

Bearing gets built in three milestones and 31 issues: foundations, then the spec's TypeScript-only MVP, then the Python, Go and Java/Kotlin adapters.

## How to read this plan

Two defaults shape it. The MVP follows the spec's "Suggested MVP scope" exactly, so it is TypeScript only and leaves continuous reconciliation on main, brownfield and SRP scoring out. Other languages come as a later milestone built on an adapter interface, using the per-language split from the [worked example](https://claude.ai/code/artifact/4b47956a-6da1-4208-a2cf-df0dd14c2e04).

| Milestone | Goal | Issues | Done when |
| --- | --- | --- | --- |
| M0 Foundations | A CLI that can load a Structurizr model and diff two models | [#1](https://github.com/My5t3ryMach1n3/bearing/issues/1) to [#5](https://github.com/My5t3ryMach1n3/bearing/issues/5) | `bearing` diffs two fixture workspaces in CI |
| M1 MVP (TypeScript) | The full design, build and change loop on one greenfield TS service | [#6](https://github.com/My5t3ryMach1n3/bearing/issues/6) to [#25](https://github.com/My5t3ryMach1n3/bearing/issues/25) | The basket fixture runs the spec's walkthrough end to end in a real PR |
| M2 Language adapters | Python, Go and Java/Kotlin services governed by the same checks | [#26](https://github.com/My5t3ryMach1n3/bearing/issues/26) to [#32](https://github.com/My5t3ryMach1n3/bearing/issues/32) | The Chairside example from the worked example passes in CI |

Labels use `area:` for the part of the system, `phase:` for the M1 design, build and change loops, and `type:spike` for time-boxed research whose output is a decision, not shipped code.

## Issues

### M0 Foundations

| Issue | Title | Depends on |
| --- | --- | --- |
| [#1](https://github.com/My5t3ryMach1n3/bearing/issues/1) | Scaffold the Bearing CLI repository | none |
| [#2](https://github.com/My5t3ryMach1n3/bearing/issues/2) | Define and load `.bearing/config.yaml` | [#1](https://github.com/My5t3ryMach1n3/bearing/issues/1) |
| [#3](https://github.com/My5t3ryMach1n3/bearing/issues/3) | Wrap the Structurizr CLI | [#2](https://github.com/My5t3ryMach1n3/bearing/issues/2) |
| [#4](https://github.com/My5t3ryMach1n3/bearing/issues/4) | Build the internal model and its diff | [#3](https://github.com/My5t3ryMach1n3/bearing/issues/3) |
| [#5](https://github.com/My5t3ryMach1n3/bearing/issues/5) | Create the basket fixture repo | [#1](https://github.com/My5t3ryMach1n3/bearing/issues/1) |

### M1 MVP (TypeScript)

| Issue | Title | Depends on |
| --- | --- | --- |
| [#6](https://github.com/My5t3ryMach1n3/bearing/issues/6) | Implement `bearing init` | [#2](https://github.com/My5t3ryMach1n3/bearing/issues/2) |
| [#7](https://github.com/My5t3ryMach1n3/bearing/issues/7) | Read requirements from GitHub Issues | [#2](https://github.com/My5t3ryMach1n3/bearing/issues/2) |
| [#8](https://github.com/My5t3ryMach1n3/bearing/issues/8) | Implement `bearing context` | [#4](https://github.com/My5t3ryMach1n3/bearing/issues/4), [#7](https://github.com/My5t3ryMach1n3/bearing/issues/7) |
| [#9](https://github.com/My5t3ryMach1n3/bearing/issues/9) | Implement `bearing validate` | [#4](https://github.com/My5t3ryMach1n3/bearing/issues/4), [#7](https://github.com/My5t3ryMach1n3/bearing/issues/7) |
| [#10](https://github.com/My5t3ryMach1n3/bearing/issues/10) | Ship the AGENTS.md section and design skill | [#8](https://github.com/My5t3ryMach1n3/bearing/issues/8), [#9](https://github.com/My5t3ryMach1n3/bearing/issues/9) |
| [#11](https://github.com/My5t3ryMach1n3/bearing/issues/11) | Extract TypeScript imports into as-built relationships | [#4](https://github.com/My5t3ryMach1n3/bearing/issues/4) |
| [#12](https://github.com/My5t3ryMach1n3/bearing/issues/12) | Extract the deployment view from Terraform | [#4](https://github.com/My5t3ryMach1n3/bearing/issues/4) |
| [#13](https://github.com/My5t3ryMach1n3/bearing/issues/13) | Build the Node trace hook for `bearing test` | [#4](https://github.com/My5t3ryMach1n3/bearing/issues/4) |
| [#14](https://github.com/My5t3ryMach1n3/bearing/issues/14) | Check criteria coverage from tagged tests | [#7](https://github.com/My5t3ryMach1n3/bearing/issues/7), [#13](https://github.com/My5t3ryMach1n3/bearing/issues/13) |
| [#15](https://github.com/My5t3ryMach1n3/bearing/issues/15) | Implement `bearing claim` and the claims file | [#4](https://github.com/My5t3ryMach1n3/bearing/issues/4), [#11](https://github.com/My5t3ryMach1n3/bearing/issues/11) |
| [#16](https://github.com/My5t3ryMach1n3/bearing/issues/16) | Implement `bearing check` with the blocking structural checks | [#9](https://github.com/My5t3ryMach1n3/bearing/issues/9), [#11](https://github.com/My5t3ryMach1n3/bearing/issues/11), [#12](https://github.com/My5t3ryMach1n3/bearing/issues/12), [#14](https://github.com/My5t3ryMach1n3/bearing/issues/14), [#15](https://github.com/My5t3ryMach1n3/bearing/issues/15) |
| [#17](https://github.com/My5t3ryMach1n3/bearing/issues/17) | Check trace paths against dynamic views | [#13](https://github.com/My5t3ryMach1n3/bearing/issues/13), [#16](https://github.com/My5t3ryMach1n3/bearing/issues/16) |
| [#18](https://github.com/My5t3ryMach1n3/bearing/issues/18) | Flag surplus code | [#11](https://github.com/My5t3ryMach1n3/bearing/issues/11), [#13](https://github.com/My5t3ryMach1n3/bearing/issues/13) |
| [#19](https://github.com/My5t3ryMach1n3/bearing/issues/19) | Implement `bearing report` | [#16](https://github.com/My5t3ryMach1n3/bearing/issues/16), [#17](https://github.com/My5t3ryMach1n3/bearing/issues/17), [#18](https://github.com/My5t3ryMach1n3/bearing/issues/18) |
| [#21](https://github.com/My5t3ryMach1n3/bearing/issues/21) | Add change proposals and target-change mode | [#16](https://github.com/My5t3ryMach1n3/bearing/issues/16), [#19](https://github.com/My5t3ryMach1n3/bearing/issues/19) |
| [#22](https://github.com/My5t3ryMach1n3/bearing/issues/22) | Build the guard job | [#1](https://github.com/My5t3ryMach1n3/bearing/issues/1) |
| [#23](https://github.com/My5t3ryMach1n3/bearing/issues/23) | Build the conformance job | [#16](https://github.com/My5t3ryMach1n3/bearing/issues/16), [#17](https://github.com/My5t3ryMach1n3/bearing/issues/17), [#19](https://github.com/My5t3ryMach1n3/bearing/issues/19) |
| [#24](https://github.com/My5t3ryMach1n3/bearing/issues/24) | Handle the requirement lifecycle | [#7](https://github.com/My5t3ryMach1n3/bearing/issues/7) |
| [#25](https://github.com/My5t3ryMach1n3/bearing/issues/25) | Run the walkthrough end to end and release v0.1 | [#6](https://github.com/My5t3ryMach1n3/bearing/issues/6) to [#24](https://github.com/My5t3ryMach1n3/bearing/issues/24) |

[#20](https://github.com/My5t3ryMach1n3/bearing/issues/20), `bearing impact`, was dropped. Without an LLM it could only guess what a new requirement touches by matching words, and the agent does that better by reading the target and the code itself. `bearing context` already prints the exact slice for an existing issue.

### M2 Language adapters

| Issue | Title | Depends on |
| --- | --- | --- |
| [#26](https://github.com/My5t3ryMach1n3/bearing/issues/26) | Define the language adapter interface and multi-language config | [#25](https://github.com/My5t3ryMach1n3/bearing/issues/25) |
| [#27](https://github.com/My5t3ryMach1n3/bearing/issues/27) | Derive relationships that go through a queue | [#12](https://github.com/My5t3ryMach1n3/bearing/issues/12), [#26](https://github.com/My5t3ryMach1n3/bearing/issues/26) |
| [#28](https://github.com/My5t3ryMach1n3/bearing/issues/28) | Build the Python adapter | [#26](https://github.com/My5t3ryMach1n3/bearing/issues/26) |
| [#29](https://github.com/My5t3ryMach1n3/bearing/issues/29) | Spike: trace Go without hand instrumentation | [#26](https://github.com/My5t3ryMach1n3/bearing/issues/26) |
| [#30](https://github.com/My5t3ryMach1n3/bearing/issues/30) | Build the Go adapter | [#29](https://github.com/My5t3ryMach1n3/bearing/issues/29) |
| [#31](https://github.com/My5t3ryMach1n3/bearing/issues/31) | Build the Java/Kotlin adapter | [#26](https://github.com/My5t3ryMach1n3/bearing/issues/26) |
| [#32](https://github.com/My5t3ryMach1n3/bearing/issues/32) | Run the Chairside example end to end | [#27](https://github.com/My5t3ryMach1n3/bearing/issues/27), [#28](https://github.com/My5t3ryMach1n3/bearing/issues/28), [#30](https://github.com/My5t3ryMach1n3/bearing/issues/30) |

## Sequencing

The MVP is mostly one line of work: the model diff ([#4](https://github.com/My5t3ryMach1n3/bearing/issues/4)) feeds the extractors and the design loop, both feed the checks, and the checks feed the report and the Action. The guard job ([#22](https://github.com/My5t3ryMach1n3/bearing/issues/22)) is the one piece that can start in parallel from day one.

In M2, Python and Java/Kotlin can run in parallel once the adapter interface lands; Go waits on its tracing spike, which is why it is marked as the risk.

## Open questions

Nine questions are left open by the spec or exposed by the worked example. Each is tied to the issue that settles it, with my suggested default in the last column; the defaults are guesses to confirm, not decisions.

| Question | Settled in | Suggested default |
| --- | --- | --- |
| How is the self-heal limit of 3 attempts enforced when Bearing can't see agent retries? | [#10](https://github.com/My5t3ryMach1n3/bearing/issues/10) | Instruction only in AGENTS.md for v0.1; count failed `bearing/conformance` runs per branch later |
| What do the ESM/CJS hook and its overhead cost on large suites? | [#13](https://github.com/My5t3ryMach1n3/bearing/issues/13) | Measure before committing; fall back to tracing only files a PR touches if overhead is high |
| Does a dynamic view need an exact trace match or a partial one? | [#17](https://github.com/My5t3ryMach1n3/bearing/issues/17) | Decided: ordered subsequence with no undeclared component between steps, and no call anywhere in the trace that the target doesn't declare |
| How does the PR comment get posted for fork PRs with no secrets? | [#23](https://github.com/My5t3ryMach1n3/bearing/issues/23) | Decided: the conformance job uploads the comment as an artifact, and a `workflow_run` job posts it after checking the PR is at the commit that was checked |
| Is the responsibilities check in v0.1 at all, given SRP scoring is out of MVP scope? | [#18](https://github.com/My5t3ryMach1n3/bearing/issues/18) | Leave it out of v0.1 and run validation experiment 5 first |
| Monorepo or multi-repo first? | [#25](https://github.com/My5t3ryMach1n3/bearing/issues/25) | Single repo, as the MVP scope says; ask pilot teams (experiment 6) |
| Should the deployment view go below an RDS instance to individual databases? | [#12](https://github.com/My5t3ryMach1n3/bearing/issues/12) | No in v0.1; note it as a known gap |
| Where does the injectable-clock convention for time-based criteria live? | [#10](https://github.com/My5t3ryMach1n3/bearing/issues/10) | In the AGENTS.md section, not in Bearing |
| How are Go functions traced without hand instrumentation? | [#29](https://github.com/My5t3ryMach1n3/bearing/issues/29) | Decided by the spike |
