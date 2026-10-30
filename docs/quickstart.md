# Quickstart

Adopt Bearing on a TypeScript service in a GitHub repo, from an empty target to the first governed PR. It follows the same loop as the [walkthrough](product-spec.md#walkthrough-a-greenfield-service), which was run end to end on real PRs in [My5t3ryMach1n3/basket](https://github.com/My5t3ryMach1n3/basket).

## What you need

- Node.js 22.15 or later.
- Docker, or Java 21, for the Structurizr CLI that Bearing runs to read the model.
- The [GitHub CLI](https://cli.github.com/), signed in. Locally, Bearing reads your requirement issues with `gh auth token` and the `origin` remote.
- A TypeScript project whose integration tests run under Vitest or Jest, and a GitHub repo for it. Terraform under one folder is optional.

## 1. Set up the repo

```sh
npm install -g bearing-cli
bearing init
gh label create requirement --description "A user story Bearing designs and checks against"
```

`bearing init` writes the model, the config, a requirement issue form, the three workflows and a section of AGENTS.md for your coding agent. Check `.bearing/config.yaml`: `tests.integration` is the command that runs your integration tests, and `iac.terraform` the folder to compare with the deployment view, if you have one.

Land these files through a PR. Once the workflows have run on a PR, turn on branch protection for main: require a pull request, and require the `bearing/target` and `bearing/conformance` checks. GitHub only lists those checks after they've run once.

If the repo wasn't cloned, for example if you created it with `gh repo create --source --push`, run `git remote set-head origin --auto` so Bearing compares branches with `origin`'s main rather than your local copy.

## 2. File requirements

Each requirement is an issue made with the **Requirement** form: a user story and numbered Given/When/Then acceptance criteria. The issue number is its ID; criteria are `#4/AC1`, `#4/AC2` and so on.

A requirement issue stays open for as long as the code serves it. Link PRs to one with `Refs #4`, never `Closes #4` or `Fixes #4`, which would close it on merge. To drop a requirement, close it as **not planned**: Bearing then lists what served only that issue for pruning.

## 3. Design the target

Ask your agent to design from the open requirements. The AGENTS.md section points it at `bearing skill`, which has it run `bearing context --issues`, write `architecture/workspace.dsl` with one dynamic view per story, record its choices as ADRs and run `bearing validate` until it passes.

The design PR changes only the model. Give its branch a name that doesn't start with an issue number, such as `design-target`; see step 4 for why.

Review it before merging: the PR comment shows the design first, as diagrams of the model, and links to the PR's target as a Structurizr static site. Download the `bearing-site` artifact from that run and open its `index.html`, then walk the dynamic views one requirement at a time. Merging the PR makes it the target that every later PR is checked against.

## 4. Build against it

For each requirement, the agent works on a branch named after the issue, starting with its number: `2-add-item` or `issue-2-add-item`. Bearing reads the issue from the name. Following AGENTS.md, it:

1. Runs `bearing context #2` for the slice of the target the issue touches, and keeps its code inside those components' folders.
2. Tags each integration test with its criterion, such as `it("#2/AC1 keeps an added item", ...)`.
3. Before pushing, runs `bearing claim`, which drafts `.bearing/claims/<branch>.yaml`; it checks the file lists the issue, fills in the note and commits it. Then it runs `bearing test` and `bearing check`.

On the PR, the conformance job runs the checks again from scratch and the comment shows the result, with an overlay of anything that drifted. A failed check says what to fix. After three failed attempts within the target, the agent proposes a target change instead.

| Check | Fails when |
| --- | --- |
| Target valid | The target breaks Bearing's rules, for example an open requirement with no dynamic view |
| Target change | The PR changes the target, but main's target changed after it forked: rebase onto it |
| Claim | The claims file doesn't match the code |
| Boundaries | Code in one component imports another along a relationship the target doesn't declare |
| Deployment | The Terraform has a node the target doesn't, lacks one, or counts instances differently |
| Criteria coverage | A criterion of the PR's issues has no passing tagged test, or the PR changes a component's code and names no issue |
| Trace paths | A tagged test's calls between components stray from its issue's dynamic view, or no tagged test takes one of the view's steps |
| Surplus (advisory) | Code is outside every component, or no tagged test reaches it |

## 5. When the target is wrong

A PR that changes the model, `.bearing/` or the workflows is a target change: the guard labels it `architecture-change` and puts the diffs at the top of the comment, and merging it approves the change. The agent adds an ADR from `architecture/adrs/template.md` with the reason and the alternatives it considered. To require a second reviewer on these, run `bearing init --owner @your-org/architects` and turn on code-owner review.

If two target changes are open at once, the first to merge wins: the other fails Target change until it's rebased onto the new target.

## 6. When requirements change

Bearing reads the issues afresh on every run.

- **A new requirement** fails Target valid on every branch, since the target has no view for it, until a target change covers it. Design it first, then build it.
- **Edited criteria** make `bearing validate` name the stale dynamic view and the tests tagged with what changed. Update them, then re-pin the view with the value `bearing context #<n>` prints.
- **A requirement closed as not planned** has what served only it listed for pruning, and its code flagged as surplus, until a PR removes them.
