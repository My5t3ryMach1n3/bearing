# Bearing

Bearing is GitOps for architecture: from a list of requirements, an agent drafts a C4 target architecture that engineers review and commit as the desired state. Every PR is then reconciled against it, and anything the code does that the model doesn't say is flagged as drift, as ArgoCD flags a cluster that's out of sync.

The as-built state comes from deterministic analysis of code, infrastructure and test traces, not from the agent's own account. The target only moves through an approved change proposal.

## Status

The TypeScript MVP is built: design from requirements, the checks, the PR comment and the GitHub Action. The [walkthrough](docs/product-spec.md#walkthrough-a-greenfield-service) has been run end to end on real PRs in [My5t3ryMach1n3/basket](https://github.com/My5t3ryMach1n3/basket). Other languages are planned as GitHub issues.

## Install

Bearing needs Node.js 22 or later.

```sh
npm install -g bearing-cli
bearing --help
```

The npm package is `bearing-cli`; the command it installs is `bearing`.

To adopt Bearing in a repo, follow the [quickstart](docs/quickstart.md). In short: run `bearing init` at its root. It writes the model, config, requirement issue form, workflows and the AGENTS.md section, then prints the branch-protection settings to turn on. Re-running it only adds what's missing.

Whoever merges a PR approves any target change it makes; Bearing labels those PRs and shows the model diff first. To require a second reviewer instead, pass owners, e.g. `bearing init --owner @your-org/architects`: init adds CODEOWNERS entries for the model, config and workflows, and asks you to require code-owner review.

## Trace overhead

`bearing test` traces every call into a component's exports, so tests run slower under it. Measured with Node 25.4 on a 16-core Linux machine (WSL2), as the median of 5 or 10 alternating plain and traced runs after a warm-up:

| Suite | Tests | Spans | Plain | Traced | Overhead |
| --- | --- | --- | --- | --- | --- |
| Basket fixture, integration tests (Vitest 4) | 11 | 145 | 0.77 s | 1.00 s | +29% |
| [date-fns](https://github.com/date-fns/date-fns) core at `a9739fb` (Vitest 5), its own config | 3,166 | 71,000 | 2.60 s | 3.04 s | +17% |
| The same, with Vitest's module cache off | 3,166 | 71,000 | 4.66 s | 5.66 s | +22% |

date-fns was mapped as one component per function folder, 254 in all, so nearly every call it makes is traced. On the fixture most of the extra time is fixed: loading TypeScript to rewrite the component files.

## Docs

- [Quickstart](docs/quickstart.md): set up a repo, design the target and land the first governed PR.
- [Product spec](docs/product-spec.md): the problem, the proposed solution, how it works, and a walkthrough on a greenfield service.
- [Build plan](docs/build-plan.md): the three milestones, how the issues sequence, and the open questions they settle.
- [E2E scenario](e2e/README.md): Shelf, a test app built with Bearing stage by stage as Bearing's issues close.
- [Contributing](CONTRIBUTING.md): setup, checks and how changes land.

## Licence

[MIT](LICENSE).

## Tracking

- [Issues](https://github.com/My5t3ryMach1n3/bearing/issues): one per unit of work, with acceptance criteria and "blocked by" links.
- [Milestones](https://github.com/My5t3ryMach1n3/bearing/milestones): M0 Foundations, M1 MVP (TypeScript), M2 Language adapters.
