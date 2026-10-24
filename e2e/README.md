# E2E scenario: Shelf

Shelf is a small test app you build with Bearing as Bearing itself gets built. It's an office book-lending API in TypeScript with Postgres: colleagues borrow and return books, and a librarian sees what's overdue. It is deliberately not the basket fixture ([#5](https://github.com/My5t3ryMach1n3/bearing/issues/5)), so it tests Bearing on something it wasn't tuned against.

The scenario follows the spec's walkthrough. Shelf goes through each loop for real: design from requirements, governed PRs with planted mistakes, a target change, human drift, a new requirement, and finally a second language.

## How it prompts you

Each stage in [`stages/`](stages) lists the Bearing issues it needs in its `requires:` line. When the last of them closes, the [E2E stages workflow](../.github/workflows/e2e-stages.yml) opens an issue labelled `e2e`, assigned to you, with that stage's checklist. Stage 0 needs nothing and opens the first time the workflow runs.

Work through the checklist in Shelf, then close the stage issue. Anything Bearing got wrong or made awkward gets its own issue here, linked from a comment on the stage issue, so the scenario keeps feeding the build.

To check for newly unlocked stages by hand: `gh workflow run e2e-stages.yml -R My5t3ryMach1n3/bearing`.

## Ground rules

- Shelf lives in its own repo, `My5t3ryMach1n3/shelf`, so requirement issue numbers there start at 1. These docs write them as `shelf#2` to keep them apart from Bearing's issues.
- Use a coding agent for the code, as the spec intends. You play the engineer: you write the requirements, review the model and approve or reject.
- Planted mistakes are marked **Plant**. Make each one on its own branch, see Bearing catch it, then throw the branch away.
- Terraform under `infra/` is only ever parsed. Never run `terraform apply`.

## Requirements

File these in Shelf with the `requirement` label in stage 0. Bearing's issue form doesn't exist until [#7](https://github.com/My5t3ryMach1n3/bearing/issues/7), so paste the bodies by hand.

### shelf#1 Add a book

**Story**
As a librarian, I want to add a book to the shelf, so that colleagues can borrow it.

**Acceptance criteria**
1. Given a librarian, when they add a book with a title and ISBN, then it is listed as available.
2. Given a book with that ISBN already on the shelf, when the librarian adds it again, then the request is rejected as a duplicate.

### shelf#2 Borrow a book

**Story**
As a colleague, I want to borrow an available book, so that I can read it.

**Acceptance criteria**
1. Given an available book, when a colleague borrows it, then a loan is recorded with a due date 14 days from today and the book is marked as on loan.
2. Given a book that is on loan, when another colleague tries to borrow it, then the request is rejected.

### shelf#3 Return a book

**Story**
As a colleague, I want to return a book I borrowed, so that someone else can borrow it.

**Acceptance criteria**
1. Given a book on loan to a colleague, when they return it, then the loan is closed and the book is available.
2. Given a book that is not on loan, when someone tries to return it, then the request is rejected.

### shelf#4 List overdue loans

**Story**
As a librarian, I want to see which loans are overdue, so that I can chase them.

**Acceptance criteria**
1. Given a loan past its due date, when the librarian lists overdue loans, then it appears with the borrower and the number of days overdue.
2. Given a loan due today, when the librarian lists overdue loans, then it does not appear.

### shelf#5 Search by title

**Story**
As a colleague, I want to search books by title, so that I can find one to borrow.

**Acceptance criteria**
1. Given books on the shelf, when a colleague searches for part of a title, then the matching books are listed with their availability.

### Filed later

These come in at the stage that needs them, not up front.

- **shelf#6 Overdue reminder email** (stage 7). As a librarian, I want borrowers emailed when a loan goes overdue, so that I don't have to chase them.
  1. Given a loan that has just become overdue, when the daily reminder runs, then the borrower is emailed once.
  2. Given the email provider is slow or down, when a colleague borrows a book, then the borrow still succeeds.
- **shelf#7 Reserve a book** (stage 9). As a colleague, I want to reserve a book that's on loan, so that I get it next.
  1. Given a book on loan, when a colleague reserves it, then they join the queue for it.
  2. Given a reserved book, when it is returned, then it is held for the first person in the queue and they are emailed.

## Stages

| Stage | What you exercise | Unlocks when these close |
| --- | --- | --- |
| [0](stages/00-set-up-shelf.md) | Shelf repo and requirements | nothing |
| [1](stages/01-model-and-diff.md) | Config, Structurizr wrapper, model diff | #1–#4 |
| [2](stages/02-init.md) | `bearing init` | #6 |
| [3](stages/03-design-loop.md) | Design from requirements, review, commit the target | #7–#10 |
| [4](stages/04-first-governed-pr.md) | Claim, Boundaries, Deployment, Criteria coverage | #11–#16 |
| [5](stages/05-traces-and-surplus.md) | Trace paths, surplus code | #17, #18 |
| [6](stages/06-ci-on-real-prs.md) | PR comment, guard and conformance jobs | #19, #22, #23 |
| [7](stages/07-target-change.md) | Change proposal and target-change mode | #21 |
| [8](stages/08-human-drift.md) | A human drifts in Terraform | #12, #23 |
| [9](stages/09-requirement-lifecycle.md) | Impact, edited and dropped requirements | #20, #24 |
| [10](stages/10-v0-1-from-scratch.md) | The v0.1 release from a cold start | #25 |
| [11](stages/11-python-worker.md) | A Python worker behind a queue | #26–#28 |
| [12](stages/12-go-worker.md) | Optional: the worker rewritten in Go | #30 |
