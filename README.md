# Bearing

Bearing is architecture used to control agentic engineering. From a list of requirements, an agent drafts a C4 target architecture that engineers review and commit. From then on, every PR the agent opens is checked against that target: code that crosses a boundary the target doesn't declare, or does something the model doesn't say, fails the PR until it's fixed or the target is changed on purpose.

The as-built state comes from deterministic analysis of code, infrastructure and test traces, not from the agent's own account. The target only moves through an approved change proposal, so the agent can't quietly redesign the system while building it.

> [!WARNING]
> Bearing is an MVP. It's early, its commands, file formats and checks may change between releases without notice, and it hasn't been hardened for production use. Use it at your own risk.

## Status

The TypeScript MVP is built: design from requirements, the checks, the PR comment and the GitHub Action. The [walkthrough](docs/product-spec.md#walkthrough-a-greenfield-service) has been run end to end on real PRs in [My5t3ryMach1n3/basket](https://github.com/My5t3ryMach1n3/basket). Go and Python are supported too, through the adapters in [`src/lang/go.ts`](src/lang/go.ts) and [`src/lang/python.ts`](src/lang/python.ts). Additional languages may be added in future.

## Install

Bearing needs Node.js 22 or later.

```sh
npm install -g bearing-cli
bearing --help
```

The npm package is `bearing-cli`; the command it installs is `bearing`.

To adopt Bearing in a repo, follow the [quickstart](docs/quickstart.md). In short: run `bearing init` at its root. It writes the model, config, requirement issue form, workflows and the AGENTS.md section, then prints the branch-protection settings to turn on. Re-running it only adds what's missing.

Bearing relies on branch protection to stop a PR merging past a failed check. GitHub offers branch protection on public repos, and on private ones only on GitHub Pro, Team or Enterprise, so on a free plan, the repo must be public. If you're having an agent create the repo, have it create a public one.

Whoever merges a PR approves any target change it makes; Bearing labels those PRs and shows what changes about the architecture first. To require a second reviewer instead, pass owners, e.g. `bearing init --owner @your-org/architects`: init adds CODEOWNERS entries for the model, config and workflows, and asks you to require code-owner review.

## How it's meant to be used

Bearing puts a human in charge of the design and an agent in charge of the code, with CI holding the line between them. The [quickstart](docs/quickstart.md) has the full steps; the loop is:

1. **File requirements.** Each requirement is a GitHub issue with a user story and numbered Given/When/Then acceptance criteria. Close each one as completed once it's delivered, and as not planned to drop it.
2. **Have the agent design the target.** It reads the open requirements and writes a C4 model, `architecture/workspace.dsl`, with one dynamic view per story and an ADR for each choice it makes.
3. **Review and merge the design.** The PR comment shows the design as diagrams. Merging it makes it the target that every later PR is checked against. This is where your judgement goes in.
4. **Let the agent build against it.** For each requirement it works on a branch named after the issue, keeps its code inside the target's components, tags its tests with the criteria they cover and runs `bearing check` before pushing.
5. **Review the result, not the reasoning.** Each PR gets a comment and an architecture page showing whether the target changed, where the code drifted and which steps the tests took. A failed check tells the agent what to fix.
6. **Change the target deliberately.** When the design turns out to be wrong, the agent proposes a target change with an ADR. Bearing labels the PR, shows what changes about the architecture first, and whoever merges it approves the change.

Bearing doesn't write your code or choose your architecture for you. It keeps an agent's work inside the architecture you approved, and makes any departure from it visible and explicit.

## Docs

- [Quickstart](docs/quickstart.md): set up a repo, design the target and land the first governed PR.
- [Product spec](docs/product-spec.md): the problem, the proposed solution, how it works, and a walkthrough on a greenfield service.
- [Build plan](docs/build-plan.md): the three milestones, how the issues sequence, and the open questions they settle.
- [E2E scenario](e2e/README.md): Shelf, a test app built with Bearing stage by stage as Bearing's issues close.
- [Contributing](CONTRIBUTING.md): setup, checks and how changes land.

## Licence

[MIT](LICENSE). Bearing is provided as is, without warranty of any kind; see the licence for the full terms.

## Tracking

- [Issues](https://github.com/My5t3ryMach1n3/bearing/issues): one per unit of work, with acceptance criteria and "blocked by" links.
- [Milestones](https://github.com/My5t3ryMach1n3/bearing/milestones): M0 Foundations, M1 MVP (TypeScript), M2 Language adapters.
