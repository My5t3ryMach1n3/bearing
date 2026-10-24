# Bearing build plan: issues

One file per issue, exported from the Bearing Build Plan (Issues) doc on 2026-10-24. Each file is shaped to paste into GitHub as an issue or to hand to a coding agent.

Bearing gets built in three milestones and 32 issues: foundations, then the spec's TypeScript-only MVP, then the Python, Go and Java/Kotlin adapters. Each entry below is shaped to paste into GitHub as an issue: a title, labels, what it depends on, a short description and acceptance criteria to tick off.

## How to read this plan

Two defaults shape it. The MVP follows the spec's "Suggested MVP scope" exactly, so it is TypeScript only and leaves continuous reconciliation on main, brownfield and SRP scoring out. Other languages come as a later milestone built on an adapter interface, using the per-language split from the [worked example](https://claude.ai/code/artifact/4b47956a-6da1-4208-a2cf-df0dd14c2e04). Nothing is created on GitHub yet, because no repository is attached to this project.

| Milestone | Goal | Issues | Done when |
| --- | --- | --- | --- |
| M0 Foundations | A CLI that can load a Structurizr model and diff two models | B-01 to B-05 | `bearing` diffs two fixture workspaces in CI |
| M1 MVP (TypeScript) | The full design, build and change loop on one greenfield TS service | B-06 to B-25 | The basket fixture runs the spec's walkthrough end to end in a real PR |
| M2 Language adapters | Python, Go and Java/Kotlin services governed by the same checks | B-26 to B-32 | The Chairside example from the worked example passes in CI |

Issue IDs (B-01 and so on) are placeholders for the GitHub numbers. Labels use `area:` for the part of the system and `type:spike` for time-boxed research whose output is a decision, not shipped code.

## Issues


### M0 Foundations

| Issue | Title | Depends on |
| --- | --- | --- |
| [B-01](B-01-scaffold-the-bearing-cli-repository.md) | Scaffold the Bearing CLI repository | none |
| [B-02](B-02-define-and-load-bearing-config-yaml.md) | Define and load `.bearing/config.yaml` | B-01 |
| [B-03](B-03-wrap-the-structurizr-cli.md) | Wrap the Structurizr CLI | B-02 |
| [B-04](B-04-build-the-internal-model-and-its-diff.md) | Build the internal model and its diff | B-03 |
| [B-05](B-05-create-the-basket-fixture-repo.md) | Create the basket fixture repo | B-01 |

### M1 MVP (TypeScript)

| Issue | Title | Depends on |
| --- | --- | --- |
| [B-06](B-06-implement-bearing-init.md) | Implement `bearing init` | B-02 |
| [B-07](B-07-read-requirements-from-github-issues.md) | Read requirements from GitHub Issues | B-02 |
| [B-08](B-08-implement-bearing-context.md) | Implement `bearing context` | B-04, B-07 |
| [B-09](B-09-implement-bearing-validate.md) | Implement `bearing validate` | B-04, B-07 |
| [B-10](B-10-ship-the-agents-md-section-and-design-skill.md) | Ship the AGENTS.md section and design skill | B-08, B-09 |
| [B-11](B-11-extract-typescript-imports-into-as-built-relationships.md) | Extract TypeScript imports into as-built relationships | B-04 |
| [B-12](B-12-extract-the-deployment-view-from-terraform.md) | Extract the deployment view from Terraform | B-04 |
| [B-13](B-13-build-the-node-trace-hook-for-bearing-test.md) | Build the Node trace hook for `bearing test` | B-04 |
| [B-14](B-14-check-criteria-coverage-from-tagged-tests.md) | Check criteria coverage from tagged tests | B-07, B-13 |
| [B-15](B-15-implement-bearing-claim-and-the-claims-file.md) | Implement `bearing claim` and the claims file | B-04, B-11 |
| [B-16](B-16-implement-bearing-check-with-the-blocking-structural-checks.md) | Implement `bearing check` with the blocking structural checks | B-09, B-11, B-12, B-14, B-15 |
| [B-17](B-17-check-trace-paths-against-dynamic-views.md) | Check trace paths against dynamic views | B-13, B-16 |
| [B-18](B-18-flag-surplus-code.md) | Flag surplus code | B-11, B-13 |
| [B-19](B-19-implement-bearing-report.md) | Implement `bearing report` | B-16, B-17, B-18 |
| [B-20](B-20-implement-bearing-impact.md) | Implement `bearing impact` | B-08 |
| [B-21](B-21-add-change-proposals-and-target-change-mode.md) | Add change proposals and target-change mode | B-16, B-19 |
| [B-22](B-22-build-the-guard-job.md) | Build the guard job | B-01 |
| [B-23](B-23-build-the-conformance-job.md) | Build the conformance job | B-16, B-17, B-19 |
| [B-24](B-24-handle-the-requirement-lifecycle.md) | Handle the requirement lifecycle | B-07, B-20 |
| [B-25](B-25-run-the-walkthrough-end-to-end-and-release-v0-1.md) | Run the walkthrough end to end and release v0.1 | B-06 to B-24 |

### M2 Language adapters

| Issue | Title | Depends on |
| --- | --- | --- |
| [B-26](B-26-define-the-language-adapter-interface-and-multi-language-con.md) | Define the language adapter interface and multi-language config | B-25 |
| [B-27](B-27-derive-relationships-that-go-through-a-queue.md) | Derive relationships that go through a queue | B-12, B-26 |
| [B-28](B-28-build-the-python-adapter.md) | Build the Python adapter | B-26 |
| [B-29](B-29-spike-trace-go-without-hand-instrumentation.md) | Spike: trace Go without hand instrumentation | B-26 |
| [B-30](B-30-build-the-go-adapter.md) | Build the Go adapter | B-29 |
| [B-31](B-31-build-the-java-kotlin-adapter.md) | Build the Java/Kotlin adapter | B-26 |
| [B-32](B-32-run-the-chairside-example-end-to-end.md) | Run the Chairside example end to end | B-27, B-28, B-30 |

## Sequencing
The MVP is mostly one line of work: the model diff (B-04) feeds the extractors and the design loop, both feed the checks, and the checks feed the report and the Action. The guard job (B-22) is the one piece that can start in parallel from day one.

In M2, Python and Java/Kotlin can run in parallel once the adapter interface lands; Go waits on its tracing spike, which is why it is marked as the risk.

## Open questions
Nine questions are left open by the spec or exposed by the worked example. Each is tied to the issue that settles it, with my suggested default in the last column; the defaults are guesses to confirm, not decisions.

| Question | Settled in | Suggested default |
| --- | --- | --- |
| How is the self-heal limit of 3 attempts enforced when Bearing can't see agent retries? | B-10 | Instruction only in AGENTS.md for v0.1; count failed `bearing/conformance` runs per branch later |
| What do the ESM/CJS hook and its overhead cost on large suites? | B-13 | Measure before committing; fall back to tracing only files a PR touches if overhead is high |
| Does a dynamic view need an exact trace match or a partial one? | B-17 | Ordered subsequence with no undeclared component between steps |
| How does the PR comment get posted for fork PRs with no secrets? | B-23 | Upload results as an artifact and post from a separate `workflow_run` job |
| Is the responsibilities check in v0.1 at all, given SRP scoring is out of MVP scope? | B-18 | Leave it out of v0.1 and run validation experiment 5 first |
| Monorepo or multi-repo first? | B-25 | Single repo, as the MVP scope says; ask pilot teams (experiment 6) |
| Should the deployment view go below an RDS instance to individual databases? | B-12 | No in v0.1; note it as a known gap |
| Where does the injectable-clock convention for time-based criteria live? | B-10 | In the AGENTS.md section, not in Bearing |
| How are Go functions traced without hand instrumentation? | B-29 | Decided by the spike |
