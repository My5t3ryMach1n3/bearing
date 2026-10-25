# Bearing

Bearing is GitOps for architecture: from a list of requirements, an agent drafts a C4 target architecture that engineers review and commit as the desired state. Every PR is then reconciled against it, and anything the code does that the model doesn't say is flagged as drift, as ArgoCD flags a cluster that's out of sync.

The as-built state comes from deterministic analysis of code, infrastructure and test traces, not from the agent's own account. The target only moves through an approved change proposal.

## Status

Early. `bearing init` and `bearing diff` work; the rest of the build is planned as GitHub issues.

## Install

Bearing needs Node.js 22 or later.

```sh
npm install -g bearing-cli
bearing --help
```

The npm package is `bearing-cli`; the command it installs is `bearing`.

To adopt Bearing in a repo, run `bearing init` at its root. It writes the model, config, requirement issue form, workflows and the AGENTS.md section, then prints the branch-protection settings to turn on. Re-running it only adds what's missing.

Whoever merges a PR approves any target change it makes; Bearing labels those PRs and shows the model diff first. To require a second reviewer instead, pass owners, e.g. `bearing init --owner @your-org/architects`: init adds CODEOWNERS entries for the model, config and workflows, and asks you to require code-owner review.

## Docs

- [Product spec](docs/product-spec.md): the problem, the proposed solution, how it works, and a walkthrough on a greenfield service.
- [Build plan](docs/build-plan.md): the three milestones, how the issues sequence, and the open questions they settle.
- [E2E scenario](e2e/README.md): Shelf, a test app built with Bearing stage by stage as Bearing's issues close.
- [Contributing](CONTRIBUTING.md): setup, checks and how changes land.

## Licence

[MIT](LICENSE).

## Tracking

- [Issues](https://github.com/My5t3ryMach1n3/bearing/issues): one per unit of work, with acceptance criteria and "blocked by" links.
- [Milestones](https://github.com/My5t3ryMach1n3/bearing/milestones): M0 Foundations, M1 MVP (TypeScript), M2 Language adapters.
