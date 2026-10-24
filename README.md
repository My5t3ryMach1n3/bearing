# Bearing

Bearing is GitOps for architecture: from a list of requirements, an agent drafts a C4 target architecture that engineers review and commit as the desired state. Every PR is then reconciled against it, and anything the code does that the model doesn't say is flagged as drift, as ArgoCD flags a cluster that's out of sync.

The as-built state comes from deterministic analysis of code, infrastructure and test traces, not from the agent's own account. The target only moves through an approved change proposal.

## Status

Pre-code. The design is written up and the build is planned as GitHub issues; nothing is implemented yet.

## Docs

- [Product spec](docs/product-spec.md): the problem, the proposed solution, how it works, and a walkthrough on a greenfield service.
- [Build plan](docs/build-plan.md): the three milestones, how the issues sequence, and the open questions they settle.

## Tracking

- [Issues](https://github.com/My5t3ryMach1n3/bearing/issues): one per unit of work, with acceptance criteria and "blocked by" links.
- [Milestones](https://github.com/My5t3ryMach1n3/bearing/milestones): M0 Foundations, M1 MVP (TypeScript), M2 Language adapters.
