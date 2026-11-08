<!-- Source: "Bearing — Product Spec" Claude Doc (https://claude.ai/artifact/H4ytpnXmEhMn9rmxtV95Zj), tabs Spec, How it works, Walkthrough. Copied 2026-10-15. Embedded diagrams are not included, only their captions. -->

# Bearing — Product Spec

2026-10-14 · @George

### Summary

Bearing is GitOps for architecture: from a list of requirements, an agent drafts a C4 target architecture that engineers review and commit as the desired state. Every PR is then reconciled against it, and anything the code does that the model doesn't say is flagged as drift, as ArgoCD flags a cluster that's out of sync.

The as-built state comes from deterministic analysis of code, infrastructure and test traces, not from the agent's own account. The target only moves through an approved change proposal. Tests prove *what* the code does; the reconciled model proves *how* and *where* it was done, and that it matches what was agreed.

For a story of the tool in use on a greenfield service, see the Walkthrough section below.

### Problem statement

Coding agents optimise for the local goal — make it compile, make the test pass — and the structural cost of how they got there is invisible at review time. Passing tests and a prose PR summary both hide the decisions that compound.

Failure modes to design against:

- **Misread requirements**: the code satisfies the test the agent wrote, not the intent behind it.
- **Surplus code**: speculative abstractions, unused helpers, duplicate utilities.
- **Boundary bypass**: a controller calling the database directly, a new dependency between services, a new external call.
- **Brittle success**: behaviour that only holds in the conditions the tests exercise.
- **Hidden decisions**: a summary says "added caching" but not where, with what invalidation, or which existing decision it overrode.
- **Review fatigue**: agents produce diffs faster than humans can read them, so review becomes rubber-stamping.

Who feels it: engineers running agentic systems, who need agents kept on the rails and a clear view of what they actually built.

### Why now

Architecture conformance checking is a good idea that failed on economics; coding agents change those economics. Comparing intended against actual architecture has been studied since the 1990s as [reflexion modelling](https://bura.brunel.ac.uk/handle/2438/14955) and sold in tools like [Sonargraph](https://ipfs.aleph.im/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/wiki/SonarJ.html) and [SonarQube](https://www.sonarsource.com/blog/the-architecture-gap-why-your-code-becomes-hard-to-change/), yet adoption stayed low.

| Why it stalled before | What changes with agents |
| --- | --- |
| Maintaining the intended model by hand cost more than teams would pay; in one [industrial study](https://scg.unibe.ch/assets/archive/papers/Cara16a.pdf) only 4 of 14 practitioners used conformance tools | An agent drafts the model from requirements and keeps it current at near-zero marginal cost |
| Flagged violations were mostly not fixed: [one study](https://bura.brunel.ac.uk/handle/2438/14955) found identification alone rarely led to removal | A blocked agent must fix the code or file a change proposal; it can't shrug off a flag under deadline pressure |
| The value was hard to see when humans wrote and reviewed code at the same pace | Agents now write code faster than people can review it, so a compact, checkable summary of structure becomes the bottleneck tool |
| Models lived outside the developer workflow | C4 models as code (Structurizr, LikeC4), MCP servers and CI checks put the model in the repo, the PR and the agent's context |
| Only static structure could be checked | Tracing (OpenTelemetry) and requirement-tagged tests make dynamic views verifiable, not just drawn |

The window is short: Sonar, Structurizr and Scryer are each one step from this workflow, so speed and a clear GitOps framing matter more than technical novelty.

### Users and positioning

This is a control system for engineers running agentic systems, not a compliance check: the approved target steers what agents build, and the reconciled model shows what they actually built. It's open source and free.

| Compared with | Their stance | Ours |
| --- | --- | --- |
| SonarQube architecture, Sonargraph, ArchUnit | Check: report violations against rules | Control: the target drives the agent; drift must be fixed or proposed as a target change |
| Structurizr | Model format, renderer and validator | Built on it; adds requirements-driven design and the reconciliation loop |
| [Scryer](https://glama.ai/mcp/servers/aklos/scryer) | Closest: model-first agent control in a desktop app with its own format | GitOps in CI on standard C4, traced to GitHub issues, dynamic views verified by test traces |
| Spec Kit, Kiro | Intent as text specs | Intent as a structure that can be checked deterministically |

### Proposed solution

Treat architecture the way ArgoCD treats infrastructure: engineers declare a desired architectural state in git, Bearing continuously derives the actual state from the code, and any difference is flagged as drift. The approved C4 model in main is the desired state; an as-built model, extracted deterministically from code, infrastructure and test traces, is the live state.

*[Embedded diagram: Architecture lifecycle · design loop, build loop, change proposal]*

The design loop runs once per requirement set or change; the build loop runs on every PR; a change proposal is the only way the target moves.

**The ArgoCD mapping**

| ArgoCD | This product |
| --- | --- |
| Desired state: manifests in git | Target C4 model (levels 1–3, dynamic and deployment views) in main |
| Live state: what's running in the cluster | As-built model: code mapped to components, imports and calls as relationships, IaC as deployment, test traces as dynamic views |
| Synced / OutOfSync | Each element, relationship and dynamic view marked in sync or drifted |
| Diff view | Rendered before/after of target vs as-built, changed elements only |
| Self-heal: revert live to desired | Agent fixes the code to fit the target |
| Change the manifests via PR | Architecture change proposal: a reviewed diff to the target model |
| Health status | Coverage: requirements with a passing, trace-matched dynamic view |

**Phase 1: design from requirements**

- The agent reads the requirement list (each with a stable ID) and drafts the system context, containers, components, one dynamic view per requirement, and deployment views.
- Every element and relationship carries the requirement IDs it serves, so nothing in the model is unjustified.
- It also fixes the mapping conventions the checker needs later: which package or module path each component owns, and how traces are tagged with component names.

**Phase 2: review and commit the desired state**

- The engineer reviews in Structurizr and comments; the agent revises until approved.
- The approved model is merged to main and tagged as the target for that requirement set. Key choices are recorded as ADRs alongside it.

**Phase 3: governed implementation (every PR)**

- The agent submits code plus a claimed model diff: what it believes it implemented.
- Deterministic extractors build the as-built model, then three checks run:
   1. Claim vs as-built: did the agent build what it says? Disagreement means it misunderstands its own change.
   2. As-built vs target: did it stay inside the boundaries?
   3. Traces vs dynamic views: do the requirement's tests actually take the designed path?
- Code that maps to no component, or that no requirement's trace ever exercises, is flagged as a surplus candidate.
- Fail and fixable: the agent self-heals within the existing architecture. Fail and not fixable: go to phase 4.

**Phase 4: architecture change proposal**

- When a requirement can't be met within the target, the agent proposes the target-model change in the same branch as its code, with an ADR giving the reason and the alternatives it considered. Any change to model files switches the PR into target-change mode: labelled and called out first in the PR comment, so whoever merges sees the model diff before anything else.
- The engineer approves, rejects or redirects; merging the PR is the approval. Code and target merge together.

**New requirement: the change cycle**

- The agent works out the impact on the current target: which elements, relationships and dynamic views must change. It reads the target and the code itself, starting from `bearing context` for the issues the new one builds on.
- The engineer approves the proposed target diff, then phase 3 runs as normal. Trace-derived dynamic views show whether the implementation followed the approved path.

**Design principles**

- Agents may propose changes to the desired state; only humans approve them.
- Every check that decides pass or fail is deterministic; LLMs draft and explain, they don't judge.
- Reconciliation runs continuously on main, not only on agent PRs, so human hotfixes drift visibly too.

### Requirements input

GitHub Issues are the source of truth for requirements: one issue per user story, with numbered acceptance criteria that tests trace back to.

- Each requirement is an issue created from an issue form with the label `requirement`; the issue number is its stable ID.
- The body holds a user story and numbered acceptance criteria in Given/When/Then form.
- Each acceptance criterion needs at least one integration test tagged with the issue and criterion (e.g. `#123/AC2`); traces from those tests verify the issue's dynamic view.
- Every model element and relationship lists the issue numbers it serves.
- Opening an issue triggers design or a proposed target change; editing its criteria flags its dynamic view and tests as stale; closing it as not planned triggers pruning. See [How requirement changes are caught](#how-requirement-changes-are-caught).
- Epics are parent issues; only leaf stories get dynamic views.

```markdown
**Story**
As a shopper, I want to save my basket, so that I can check out later.

**Acceptance criteria**
1. Given a signed-in shopper, when they add an item, then the basket persists across sessions.
2. Given an expired session, when they return and sign in, then their saved basket is restored.
```

### Existing ideas and prior art

The claim that nothing like this exists doesn't hold: at least one open tool, Scryer, already does model-first agent control on a C4-style hierarchy. What's still missing is a PR-centred, standard-format version built on existing C4 tooling with intent-linked dynamic views.

| Tool / approach | What it does | Overlap with this idea | Gap |
| --- | --- | --- | --- |
| [Scryer](https://glama.ai/mcp/servers/aklos/scryer) (alpha, FSL licence) | C4-style model next to code; agents plan in the model, then build; deterministic drift detection; import-graph audit of declared links; logs each prompt as "asks" and flags edits no ask accounts for | Very high: model as plan, boundary audit, surplus-edit detection | Own format, not Structurizr/LikeC4; desktop-app centred rather than PR review; no dynamic views per requirement |
| [Structurizr](https://docs.structurizr.com/as-code) + MCP server | Reference C4 "models as code" tool; validate/inspect in CI; branches; explicitly lists agent-proposed DSL changes in PRs and agent drift detection as use cases | High: the natural format and engine | Describes the workflows; doesn't ship the governance loop |
| [LikeC4](https://mcp.so/server/LikeC4/LikeC4) + MCP | Open C4-like DSL; agents query the model in natural language | Medium: model readable by agents | Read/query focus, no enforcement |
| [Repo2C4](https://www.nuget.org/packages/Repo2C4.Mcp) | Evidence-first generation of C1/C2 LikeC4 models from .NET repos, human approval before writes | Medium: bootstrapping the model | .NET only, top levels only |
| [uxxu.io](https://dev.to/uxxu/your-c4-diagrams-are-lying-to-you-and-ai-coding-is-making-it-worse-2198) | C4 platform pursuing branch-aware architecture and visual diffs | Medium: PR-time visual diff | Documentation sync, not agent control |
| [Sonar agent context](https://www.sonarsource.com/blog/your-ai-agent-doesnt-know-your-codebases-context-or-constraints/) | Gives agents the current architecture graph plus user-defined constraints, verifies inside the agent loop | High on enforcement | Constraint rules, not a reviewable C4 model |
| [GitHub Spec Kit](https://github.github.com/spec-kit/) | Spec → plan → tasks → implement; community Architecture Guard extension | Medium: intent capture upstream | Markdown specs, no structural model |
| Fitness functions (ArchUnit, NetArchTest, dependency-cruiser) | Boundary rules as tests in CI | High on boundary breaks | No visual, no intent link |
| AGENTS.md + hooks as [drift gates](https://codex.danielvaughan.com/2026/08/14/agentic-entropy-architectural-drift-coding-agents-codex-cli-conformity-seeding-spec-growth-engine-defence/) | Per-directory constraints plus post-edit scripts that reject forbidden imports | Medium | Ad hoc, per team |

**Where your angle is still distinct**

- The reconciliation framing: desired vs live architecture, continuously, with sync status per element. Scryer has drift; nobody has packaged it as GitOps for architecture.
- Greenfield design from requirements: generating levels 1–3, dynamic and deployment views from a requirement list, each element traced to requirement IDs.
- Dynamic views verified by test traces, so the requirement's path is observed, not drawn.
- Claim vs as-built check: the agent's own description of its change is tested against reality.
- Standard C4 formats and Structurizr review, so teams keep existing tooling.

### Alternative solution options

Your workflow is option C with option E for verification: a human-approved target (A) reconciled against a derived as-built model (B), with dynamic views checked from test traces (E). Options D, F and G are useful add-ons rather than alternatives.

| Option | How it works | Strength | Weakness |
| --- | --- | --- | --- |
| A. Model-first (intent leads) | Human or agent edits the model first; PR blocked until code matches | Strongest control; reviews intent before code exists | Slower; needs architects to engage up front |
| B. Code-first, model derived | Model is extracted from code after the change; reviewer sees the derived diff | No authoring burden; always accurate | Shows what happened, can't express what was intended |
| C. Hybrid two-layer | Committed model plus a proposed model per PR; checker reports drift both ways | Captures both intent and reality | Two sources to reconcile; more UI |
| D. Rules only (fitness functions) | Boundaries as ArchUnit/dependency-cruiser tests; no diagrams | Cheap, deterministic, existing tools | No visual understanding, no intent trace |
| E. Runtime-derived dynamic views | Generate dynamic diagrams from traces (OpenTelemetry) of the PR's tests | Ground truth of actual call paths | Needs instrumentation; only covers tested paths |
| F. Decision log first | Agent must emit an ADR for each design choice; model linked to ADRs | Captures the *why*, which diagrams don't | Text again; relies on agent honesty |
| G. Second-agent reviewer | Independent agent compares PR to model and writes findings | Scales review | An LLM judging an LLM; needs deterministic backing |

**Variations worth considering**

- Generate dynamic views from test execution traces rather than asking the agent to draw them: harder to fake.
- Use a lighter level-4 representation (symbol list with owners) instead of full code diagrams, which the C4 authors themselves treat as optional.
- Gate by risk: only require architecture review when the diff touches level 1–2 (systems, containers) or crosses a boundary.

### Decisions

| Topic | Decision | Why |
| --- | --- | --- |
| Code-to-component mapping | Path convention: each level-3 component owns a folder or package, fixed in phase 1 | Simplest fully deterministic option; no annotations or extra mapping file |
| Approving target changes | Whoever merges the PR approves it. Target changes are labelled and shown first, so they can't be missed. Teams that want a second reviewer opt in to a CODEOWNERS rule on the model files | A required review is ceremony for a sole owner or small team, and a bad target change is one revert away; visibility is what makes the revert happen |
| Sync strictness | Fail on undeclared relationships between components; anything goes inside a component | Guards boundaries without blocking normal refactoring |
| Agent self-heal | Agent retries within bounds for a set number of attempts, then must file a change proposal | Keeps humans out of routine fixes but stops endless workarounds |
| Evidence for dynamic views | At least one integration test per requirement, tagged with its requirement ID; traces from these are compared with the view | Unit tests rarely cross components; end-to-end tests are too slow and flaky to gate PRs |
| Reconciliation cadence | On PRs in v1; continuous reconciliation on main added later | PR checks prove the loop; main-branch checks then catch hotfixes and direct commits |
| Deployment views | Reconciled against IaC (Terraform, Kubernetes manifests) from v1 | Deployment drift is part of the desired-state promise, and IaC is already declarative and parseable |
| Non-functional requirements | Out of scope; handled by existing processes | Keeps the product focused on structure and behaviour paths |
| Trace-to-model mapping | Inferred from each span's code location via the path convention | No extra instrumentation; reuses the component mapping |
| Conflicting change proposals | First merged wins; later proposals rebase on the new target | Ordinary Git conflict handling; no locks |
| Requirement removal | Elements serving only that requirement are pruned from the target; their code is flagged as surplus | Requirement IDs on every element make orphans detectable |
| Product shape | Open-source CLI, GitHub Action and agent skill on Structurizr | Fastest to adopt and to test the core assumption |
| Trust in the model | As-built is derived deterministically; the target only moves through a merged PR that flags the change | Follows from the decisions above: the agent can't change the model without it being flagged |
| Code vs model disagreement | The target wins; the code is fixed or a change proposal is filed | Desired state is authoritative, as in GitOps |
| C4 level 4 (code) | Not modelled; code is tied to level-3 components by path | Level 4 churns on every commit; the path mapping gives the same traceability |
| First language | TypeScript | Large share of agent-written code; mature import analysis to build on |
| Agent support | Agent-agnostic: CI check plus AGENTS.md instructions; deeper integrations later | Enforcement lives in CI, so any agent is governed the same way |
| Human PRs | Same rules as agent PRs | Drift is drift whoever writes it; a target only humans can bypass isn't a target |
| Surplus code | Code outside any component path, or never exercised by any requirement's integration test; flagged for review rather than blocking | Catches both stray files and dead code inside components; untraced helpers can be false positives |
| Where reviewers see drift | PR comment with a summary and changed-element images, linking to the full Structurizr view | Keeps review inside the PR |
| Diff style | Single overlay of affected elements only, with added, removed and drifted shown in colour | Smallest picture that shows the change; counters diagram fatigue |
| Changing the target | Proposed in the same branch as the code; model-file changes put the PR into labelled target-change mode, called out first in the PR comment | No separate process, but the agent can never move the target silently |
| Brownfield | Deferred; greenfield first | Prove the loop before tackling model extraction |
| Model format | Structurizr DSL | Enforces the C4 hierarchy and rules, which is the point of a control system; validate and inspect run in CI |
| Requirement source | GitHub Issues: user stories with numbered Given/When/Then acceptance criteria | Stable IDs, linkable from PRs, and each criterion maps to a test |
| Licence and price | Open source, free | Adoption by engineers running agents comes first |
| Structurizr dependency | MVP requires the Structurizr CLI (Java or Docker); Bearing calls it once to turn the DSL into workspace JSON and does everything else in TypeScript | Keeps Structurizr's validation without spreading Java through the codebase; swappable later |
| Claimed model diff | A file per branch at .bearing/claims/<branch>.yaml, kept after merge | Versioned with the code, can't be edited after checks run, no merge conflicts, and builds a history of each agent's accuracy |
| Diagram rendering | Structurizr DSL is the source of truth; Bearing generates Mermaid overlays for the PR comment, plus a Structurizr static-site export as a build artifact | GitHub renders Mermaid natively; no headless browser or image hosting |
| Protecting the checks | Guard job on pull_request_target reads changed paths only and never runs PR code; conformance job on pull_request with no secrets; a PR that edits the workflows is flagged as a target change. Teams that let agents or others merge gate .github/workflows/ with CODEOWNERS or a required workflow | A PR can't switch off the guard that flags it. The conformance workflow runs from the PR, so editing it is the one way to weaken a check: it is always flagged, and gated where the team opts in |

### Validation plan

The riskiest assumption is that people act on drift flags; test it first, on one greenfield TypeScript service, before building the full loop. Thresholds marked "target" are proposals to agree before each experiment starts.

| # | Question | Experiment | Success signal |
| --- | --- | --- | --- |
| 1 | Do teams act on drift flags, or override them? | Pilot the PR check for 4 weeks; log every flag and its outcome (fixed, change proposal, overridden) | Most flags end fixed or in a proposal (target: >70%), not overridden |
| 2 | Do reviewers engage with the architecture diff? | Seed known boundary violations into a sample of agent PRs; compare catch rate with and without the PR comment; track clicks through to Structurizr | Seeded violations caught clearly more often with the comment |
| 3 | How large can a model get before review breaks down? | Generate models for 3 open-source TypeScript repos of rising size; time reviewers on changed-only overlays and count missed changes | Find the element count where review time or misses jump; set slice limits below it |
| 4 | What does the loop cost per change? | Run the same requirement set with and without the loop; measure tokens, wall-clock time, PR size and post-merge rework | Extra cost is outweighed by less rework (target: net time saved per requirement) |
| 5 | How should single responsibility be measured? | Score pilot components on responsibility count, fan-in/fan-out and change coupling; compare with engineers' own ranking of overloaded components | One metric agrees well with engineers; ship it as advisory only |
| 6 | Monorepo or multi-repo first? | Ask 10 to 15 target teams about repo layout during discovery interviews | Build for the layout most pilot teams use |

### Risks and open assumptions

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Model becomes the agent's alibi | An agent-authored model can rationalise bad code | Deterministic model-vs-code check; model diffs flagged first in the PR for whoever merges |
| Target change merged unread | With no required review, a flagged model diff can still be merged without anyone reading it | Label and diff-first comment make it hard to miss; a revert restores the old target; teams can opt in to code-owner review |
| Diagram fatigue | Reviewers skim pictures as they skim code | Show only changed elements; highlight flags first |
| Level-4 churn | Code diagrams change constantly and bloat PRs | Generate level 4; review levels 1–3 by default |
| Language coverage | Import/call analysis is language-specific | Start with 2 languages; heuristic tier for others |
| Crowded space | Scryer, Sonar and Structurizr are converging on this | Differentiate on PR-native review and standard formats; consider building on Structurizr/LikeC4 rather than a new DSL |
| Dynamic views are hand-drawn fiction | An agent may draw the path it intended, not the one built | Derive from test traces where possible |
| Misplaced code | An agent puts code in whichever component's folder lets the import pass, keeping the boundary check green while breaking the design | Responsibility check flags overloaded components; the PR comment shows which component each new file landed in |
| Test padding | An agent writes tests only to touch code and clear surplus flags | Only tests tagged with an acceptance criterion count as trace evidence |
| Responsibility creep | An agent widens a component's description to cover new code | Responsibilities live in the target model, so changing them is a model diff, flagged as a target change |

**Assumptions to validate**: reviewers will engage with diagrams; teams will accept authoring a model; boundary violations are a top-three pain in agent PRs.

### Suggested MVP scope and success metrics

Prove the reconciliation loop on one greenfield service in one language: requirements in, approved Structurizr target out, and a GitHub Action that reports sync status on every PR.

**In scope**

- Requirements-to-model skill: generates levels 1–3 and one dynamic view per requirement, with requirement IDs and a component-to-path mapping file.
- Review loop in Structurizr; approved model merged to main as the target.
- Extractor that builds the as-built model from imports and the mapping file.
- PR check reporting claim vs as-built and as-built vs target, with changed elements rendered before/after.
- Trace check: integration tests tagged with requirement IDs, OpenTelemetry spans mapped to components, observed path compared with the dynamic view.
- Change proposal template: target diff, reason, alternatives considered.
- Deployment check: as-built deployment view parsed from IaC (Terraform or Kubernetes manifests) and compared with the target deployment view.

**Out of scope for MVP**: continuous reconciliation on main, brownfield model extraction, multiple languages, SRP scoring, multi-repo models, non-functional requirements.

**Success metrics to pick from**

- Boundary violations caught before merge versus found later.
- Share of agent PRs needing architectural rework after merge.
- Reviewer time per agent PR, and reviewer-reported confidence.
- Model drift: undeclared relationships in main over time (target zero).

**Next step**: try Scryer and the Structurizr MCP server on a real repo for a week each, and write down exactly what's missing. That gap list is your positioning.

### Roadmap ideas

Not committed; kept as candidates after the MVP.

- Continuous reconciliation on main, catching hotfixes and direct commits.
- Brownfield onboarding: extract a baseline model from existing code, curate it, adopt it as the target.
- More languages: Python, Java/Kotlin, Go.
- Multi-repo models spanning several repositories and their PRs.
- Deeper agent integrations (MCP server, Claude Code hooks) beyond the CI check.
- Falsification probes: deliberately break code behind a criterion to prove its test would notice.


## How it works

Bearing is a deterministic TypeScript CLI plus a GitHub Action. Your coding agent does the creative work, following instructions Bearing installs; Bearing does all the checking and never calls an LLM. Examples are illustrative.

### Repo layout

```text
architecture/
  workspace.dsl              # target model: the desired state
  adrs/                      # architecture decision records, from adrs/template.md
.bearing/
  config.yaml                # language, test command, IaC paths
  claims/<branch>.yaml       # agent's claimed model diff, one per branch
  traces/                    # local trace output (git-ignored)
.github/
  CODEOWNERS                 # optional: owners for architecture/, .bearing/, workflows
  ISSUE_TEMPLATE/requirement.yml
  workflows/bearing-guard.yml
  workflows/bearing-conformance.yml
  workflows/bearing-report.yml     # posts the conformance job's comment, fork PRs included
.agents/skills/bearing-design/SKILL.md   # optional: the design skill, from `bearing skill --install`
AGENTS.md                    # includes the Bearing section
src/basket-api/basket-service/   # owned by one level-3 component
```

### The model

Each level-3 component records the folder it owns and the issues it serves as Structurizr properties, so the path mapping lives in the model itself.

```text
basketService = component "Basket service" {
  description "Adds, removes and persists basket items"
  properties {
    "bearing.path" "src/basket-api/basket-service"
    "bearing.requirements" "#1,#2,#4"
  }
}

dynamic basketApi "req-2" "#2 Add an item to the basket" {
  webApp -> basketController "POST /basket/items"
  basketController -> basketService "addItem()"
  basketService -> basketRepository "save()"
}
```

### Config

```yaml
version: 1
model: architecture/workspace.dsl
structurizr:
  runner: docker            # or: java
language: typescript
tsconfig: tsconfig.json
requirements:
  source: github-issues
  label: requirement
tests:
  integration: npm run test:integration
  tag: "#<issue>/AC<n>"
iac:
  terraform: infra/         # or, for everything in one Kubernetes cluster: kubernetes: k8s/
agent:
  selfHealAttempts: 3
checks:
  surplus: advisory
  responsibilities: advisory
```

A repo with several languages, or with code below the repo root, lists them under `languages:` in place of `language:` and `tsconfig:`. Each entry gives a `name`, a `root` folder (the repo root by default) and a `project` file relative to it (`tsconfig.json` for TypeScript, `go.mod` for Go and `pyproject.toml` for Python by default). Each language is read by its adapter; see [Writing a language adapter](language-adapters.md).

```yaml
languages:
  - name: typescript
    root: services/web
  - name: typescript
    root: services/api
    project: tsconfig.build.json
  - name: go
    root: services/reminder-worker
  - name: python
    root: services/booking-api
```

| Language | `name` | Project file | Where a test carries its tag |
| --- | --- | --- | --- |
| TypeScript and JavaScript | `typescript` | `tsconfig.json` | In its name, or a `describe` around it |
| Go | `go` | `go.mod`, one entry per module | In a subtest's name, `t.Run("#3/AC1 sends a reminder", …)` |
| Python | `python` | `pyproject.toml` | In a pytest marker, `@pytest.mark.req("#5/AC1")`, on the test, its class or its module |

Reading Go code needs the go command on `PATH`, and tracing it needs Go 1.21 or later.

Reading Python code needs Python 3.11 or later as `python3` on `PATH`, or the interpreter `BEARING_PYTHON` names; before 3.11 it needs the `tomli` package. Absolute imports resolve against the source roots `pyproject.toml` declares for setuptools, Hatch, Poetry, PDM or uv, and pytest's `pythonpath`; with none, against the project's folder and its `src/`. Tracing Python needs the tests to run under pytest 7 or later, on Python 3.9 or later.

### Commands

| Command | Who runs it | What it does |
| --- | --- | --- |
| `bearing init` | Engineer, once | Scaffolds the layout, ADR template, issue form, workflows and AGENTS.md section, plus CODEOWNERS entries if given owners; prints the branch-protection settings to turn on |
| `bearing skill` | Agent | Prints the skill for designing the target from requirements; `--install` saves it to `.agents/skills/` for agents that load skills |
| `bearing context --issues` | Agent | Prints the open requirements, the C4 rules and the DSL conventions, for designing the target |
| `bearing context #2` | Agent | Prints the slice of the model an issue touches: components, paths, relationships, its dynamic view and criteria |
| `bearing validate` | Agent, CI | Structurizr validation plus Bearing's rules: open issue IDs on every element, a path on every component, a dynamic view per issue pinning its current criteria |
| `bearing claim` | Agent | Writes the branch's claims file |
| `bearing test -- <cmd>` | Agent, CI | Runs the integration tests with tracing on |
| `bearing derive` | CI, anyone | Builds the as-built model from each language's imports, and from Terraform (deployment nodes, and relationships through queues) or Kubernetes manifests (deployment nodes) |
| `bearing check` | Agent, CI | Runs every check; exits non-zero on a blocking failure |
| `bearing report` | CI | Writes the PR comment with Mermaid overlays |
| `bearing page` | CI | Writes the PR's architecture page: one self-contained HTML file with Target, Code, Build and Behaviour tabs over a map of the architecture |
| `bearing guard` | CI | Flags a target change from the base branch: label, the changed files' diffs atop the comment, and `bearing/target` |
| `bearing post <dir>` | CI | Posts the comment the conformance job uploaded, linking its architecture page, and sets `bearing/advisory`, from the report workflow |

### Checks

| Check | Compares | Blocks merge |
| --- | --- | --- |
| Target valid | Model against C4 and Bearing rules | Yes |
| Target change | A proposed target against main's current target: first merged wins | Yes |
| Claim | Claims file against the as-built model | Yes |
| Boundaries | As-built relationships between components against the target | Yes |
| Deployment | Terraform, or Kubernetes manifests, against the target deployment view | Yes |
| Criteria coverage | Each criterion of the touched issues has a tagged test that ran and passed in CI | Yes |
| Trace paths | Traces from those tests against each issue's dynamic view | Yes |
| Surplus | Code outside any component path, in a component that serves only closed issues, or untouched by any criterion's trace | No |
| Responsibilities | Components exceeding the responsibility threshold | No |

### The claims file

```yaml
branch: issue-2-add-item
issues: ["#2"]
model:
  added: []
  removed: []
files:
  - path: src/basket-api/basket-service/addItem.ts
    component: basketService
note: "Implements #2 within existing components."
```

`bearing claim` drafts this file from the branch's diff against where it forked from main, counting uncommitted and untracked changes too, for the agent to check and commit:

- **issues** come from the branch name (`issue-2-add-item`, `2-add-item`, `feat/2-add-item`) and from the requirements of whatever the target gains.
- **model** lists the stable IDs of the elements and relationships the branch's target adds or removes. It is drafted from the target alone, never the code: the Claim check exists to catch an agent that misreads its own change, so a relationship the code makes without the target declaring it is the agent's to add.
- **files** lists the changed source files, tests and declaration files left out, each with the component whose path holds it. A file under no component path has no `component`.
- **note** is the agent's to write.

Rerunning it redrafts the model and files but keeps the issues and note. The file is named after the branch, with anything outside `A-Z a-z 0-9 . _ -` percent-encoded, so `feat/2-add-item` is `.bearing/claims/feat%2F2-add-item.yaml`.

### Agent instructions

`bearing init` adds this section to AGENTS.md, so any agent follows the same loop. The design steps are a skill that `bearing skill` prints: how to walk each story, draft levels 1 to 3, give components paths, add one dynamic view per story and a deployment view, tag everything with issues, record ADRs and validate. Init never installs it; an agent that loads skills offers to save it to `.agents/skills/bearing-design/SKILL.md` with `bearing skill --install`, and runs it only if the user agrees. The self-heal limit is read from `agent.selfHealAttempts`; Bearing can't see an agent's retries, so for now it is an instruction, not a check.

```markdown
### Bearing
- To design or revise the target, follow the steps `bearing skill` prints: run `bearing context --issues`, write
  architecture/workspace.dsl, record key choices as ADRs in architecture/adrs/, then `bearing validate`.
  If you load skills, offer to save them as one with `bearing skill --install`, and only run it if the user agrees.
- Before coding an issue, run `bearing context #<issue>`; keep code inside the component paths it lists.
- Tag every integration test with its criterion, e.g. `#12/AC2`.
- For criteria that depend on time, such as expiry, pass the clock in as a dependency so tests set the time instead
  of waiting.
- Before pushing: `bearing claim`, `bearing test -- npm run test:integration`, `bearing check`.
- If a check fails, fix the code within the target. After 3 failed attempts, propose a target change in
  architecture/workspace.dsl on the same branch, with an ADR from architecture/adrs/template.md giving the reason
  and the alternatives you considered. If another target change merges first, rebase onto it and rework yours on top.
- Never edit .bearing/config.yaml or anything in .github/workflows/.
```

### How imports map to relationships

`bearing derive` maps every file in each configured language's project, the tsconfig for TypeScript, to the component whose `bearing.path` holds it. Each import from one component's file to code another component declares is an as-built relationship, `<source>-><destination>`, listed with the file and line of every import that makes it. Imports inside one component make none.

Imports are resolved the way TypeScript resolves them, `tsconfig` paths included, and followed through barrels and re-exports to the file that declares what they use, so reaching the repository's code through the service's index still reads as a dependency on the repository. Type-only imports count. `import * as` and `export * from` depend on everything the module exports; side-effect imports, `import()` and `require()` depend on the module's file. Packages are ignored.

In Go, an import names a package, so it counts towards the component holding the package's folder. Bearing lists the module's packages with `go list -deps`, so imports reach packages in other modules of the repo, such as those in the same `go.work`. Only files in the current build context count: a file for another OS isn't read. The standard library, packages outside the repo and vendored packages are ignored.

Source files under no component path are listed for the surplus check. Tests (`*.test.ts`, `*.spec.ts`, `*_test.go` and anything under `test/`, `tests/` or `__tests__/`) and declaration files are left out: they make no relationships and are never surplus.

### How Terraform maps to deployment nodes

When `iac.terraform` is set, `bearing derive` also reads the `.tf` files in that directory, one root module as Terraform reads it, and prints the deployment nodes it finds under `deployment`. Kubernetes manifests are read as [below](#how-kubernetes-manifests-map-to-deployment-nodes).

Each resource of a type in this table is one node:

| Resource type | Node | Technology | Matches a target node whose technology contains | Instances from |
| --- | --- | --- | --- | --- |
| `aws_cloudfront_distribution` | Infrastructure | Amazon CloudFront | CloudFront | |
| `aws_lb`, `aws_alb` | Infrastructure | Elastic Load Balancing | Load balancer, ALB, NLB, GLB or ELB | |
| `aws_api_gateway_rest_api`, `aws_apigatewayv2_api` | Infrastructure | Amazon API Gateway | API Gateway | |
| `aws_sqs_queue` | Infrastructure | Amazon SQS | SQS | |
| `aws_sns_topic` | Infrastructure | Amazon SNS | SNS | |
| `aws_ecs_service` | Deployment | Amazon ECS | ECS or Fargate | `desired_count` |
| `aws_lambda_function` | Deployment | AWS Lambda | Lambda | |
| `aws_instance` | Deployment | Amazon EC2 | EC2 | `count` |
| `aws_db_instance`, `aws_rds_cluster` | Deployment | Amazon RDS | RDS or Aurora | |
| `aws_dynamodb_table` | Deployment | Amazon DynamoDB | DynamoDB | |
| `aws_elasticache_cluster` | Deployment | Amazon ElastiCache | ElastiCache | `num_cache_nodes` |
| `aws_elasticache_replication_group` | Deployment | Amazon ElastiCache | ElastiCache | `num_cache_clusters` |
| `aws_s3_bucket` | Deployment | Amazon S3 | S3 | |

These types configure, connect or secure a node rather than being one, so they make no node: `aws_acm_*`, `aws_api_gateway_*`, `aws_apigatewayv2_*`, `aws_appautoscaling_*`, `aws_cloudfront_cache_policy`, `aws_cloudfront_origin_access_control`, `aws_cloudfront_origin_access_identity`, `aws_cloudwatch_*`, `aws_db_parameter_group`, `aws_db_subnet_group`, `aws_ecs_cluster`, `aws_ecs_cluster_capacity_providers`, `aws_ecs_task_definition`, `aws_eip`, `aws_elasticache_parameter_group`, `aws_elasticache_subnet_group`, `aws_iam_*`, `aws_internet_gateway`, `aws_kms_*`, `aws_lambda_permission`, `aws_lb_*`, `aws_nat_gateway`, `aws_rds_cluster_instance`, `aws_route`, `aws_route_table`, `aws_route_table_association`, `aws_route53_*`, `aws_s3_bucket_*`, `aws_secretsmanager_*`, `aws_security_group`, `aws_security_group_rule`, `aws_sns_topic_*`, `aws_sqs_queue_*`, `aws_ssm_parameter`, `aws_subnet`, `aws_vpc` and `aws_vpc_*`. Any other resource, and every `module` block, is listed under `unknown` with its file and line rather than dropped. Modules aren't followed yet. `data` blocks deploy nothing and are skipped.

Nodes are compared with the target's deployment view, which must have exactly one environment for now. A resource matches the target node whose `bearing.terraform` property names its address, e.g. `"bearing.terraform" "aws_ecs_service.basket_api"`. Failing that, it matches by technology when its kind has exactly one resource and one target node left. Two buckets and two S3 nodes stay unmatched until the nodes say which bucket is which. A matched node takes the target's ID; an unmatched resource keeps its address as its ID, so it reads as a node the target doesn't have. A target node of a mapped technology with no resource reads as removed. A node whose instances come from a plain number in the resource drifts when the number differs from the target's. Nodes of no mapped technology, such as a region grouping the others, and the container instances inside matched nodes aren't compared.

`count` and `for_each` read as one node, and a node stops at the resource: an RDS instance is one node however many databases it holds, which is a known gap in v0.1.

### How Kubernetes manifests map to deployment nodes

Some systems run everything in one Kubernetes cluster: the front end, the back end and the database, on a developer's machine or on an edge device such as a server in a clinic or a shop. For those, `iac.kubernetes` takes the place of `iac.terraform`. Only one of the two can be set for now, as Bearing compares one source with the one deployment environment.

When `iac.kubernetes` is set, `bearing derive` reads the `.yaml`, `.yml` and `.json` files in that directory as `kubectl apply -f` reads it: subfolders aren't read, a file may hold several documents, and a `List` stands for its items. Helm charts and Kustomize overlays aren't rendered; render them into a folder first, with `helm template` or `kustomize build`, and point `iac.kubernetes` at that. A folder that is a chart, or a chart's `templates/`, is refused.

An object is named `<kind>/<name>`, or `<kind>/<namespace>/<name>` when its manifest sets a namespace, e.g. `Deployment/booking-api`. Each object of a kind in this table is one node:

| Kind (API group) | Node | Technology | Matches a target node whose technology contains | Instances from |
| --- | --- | --- | --- | --- |
| `Deployment` (apps) | Deployment | Kubernetes Deployment | Deployment | `spec.replicas` |
| `StatefulSet` (apps) | Deployment | Kubernetes StatefulSet | StatefulSet | `spec.replicas` |
| `DaemonSet` (apps) | Deployment | Kubernetes DaemonSet | DaemonSet | |
| `ReplicaSet` (apps) | Deployment | Kubernetes ReplicaSet | ReplicaSet | `spec.replicas` |
| `Pod` (core) | Deployment | Kubernetes Pod | Pod | |
| `Job` (batch) | Deployment | Kubernetes Job | Job, but not CronJob | |
| `CronJob` (batch) | Deployment | Kubernetes CronJob | CronJob | |
| `Ingress` (networking.k8s.io) | Infrastructure | Kubernetes Ingress | Ingress | |
| `Service` (core) of `type: LoadBalancer` | Infrastructure | Kubernetes LoadBalancer Service | Load balancer, ALB, NLB, GLB or ELB | |

These kinds configure, connect or secure a node rather than being one, so they make no node: `ConfigMap`, `Endpoints`, `LimitRange`, `Namespace`, `PersistentVolume`, `PersistentVolumeClaim`, `ResourceQuota`, `Secret`, `Service` of any other type, `ServiceAccount`, `HorizontalPodAutoscaler`, `EndpointSlice`, `IngressClass`, `NetworkPolicy`, `PodDisruptionBudget`, `ClusterRole`, `ClusterRoleBinding`, `Role`, `RoleBinding`, `PriorityClass` and `StorageClass`. Any other kind, such as a custom resource, or a known kind in another API group, is listed under `unknown` with its file and line.

Give each workload its own deployment node in the target, holding the container instances it runs, inside nodes for the machine, the cluster and the namespace as you like. One cluster usually runs several Deployments, so matching by technology alone rarely settles which is which. An object matches:

1. the target node whose `bearing.kubernetes` property names it, e.g. `"bearing.kubernetes" "StatefulSet/chairside/postgres"`;
2. failing that, the target node of the same kind of node (deployment or infrastructure) with the same name, ignoring case, spaces and punctuation, so `deploymentNode "Booking API"` matches `Deployment/booking-api`. A name two objects or two target nodes share matches neither;
3. failing that, by technology, when its kind has exactly one object and one target node left.

A matched node takes the target's ID; an unmatched object keeps its address, so it reads as a node the target doesn't have. A target node holding container or software system instances and no other node is a workload, and is compared whatever its technology, so a "PostgreSQL 16" node with no StatefulSet reads as removed. So is a node pinned with `bearing.kubernetes` or of a technology in the table. Nodes that only group others, such as the machine, the cluster and the namespace, aren't compared. A node's instances drift when `spec.replicas` is a plain number that differs from the target's.

Calls between workloads aren't read from the manifests. A call one service makes to another through a Service is seen in the caller's traces instead: see [Traces across HTTP](#traces-across-http).

### How queues map to relationships

Code that sends to a queue and code that receives from it never import each other, so imports can't show a relationship through a queue. The Terraform can: a deployment node's code may only use a queue that the role it runs as is allowed to. When `iac.terraform` is set, `bearing derive` builds these relationships from each `aws_sqs_queue` and the IAM policies around it, and prints them under `queues`, each with the file and line of every IAM statement that allows it.

- **The role**: an `aws_ecs_service` runs as its task definition's `task_role_arn`, and an `aws_lambda_function` as its `role`. An ECS task's execution role pulls images and writes logs, so it doesn't count.
- **The policies**: the role's `inline_policy` blocks and `managed_policy_arns`, and every `aws_iam_role_policy`, `aws_iam_role_policy_attachment` and `aws_iam_policy_attachment` naming it. A policy can be `jsonencode(...)`, JSON in a string or heredoc, or an `aws_iam_policy_document` data source with the documents it builds on.
- **The statements**: an Allow statement whose actions match `sqs:SendMessage` or `sqs:SendMessageBatch` lets the node send to the queues its resources name, and one that matches `sqs:ReceiveMessage` lets it receive. Actions match as IAM matches them, ignoring case and with wildcards, so `sqs:*` allows both. A resource names a queue by reference, such as `aws_sqs_queue.appointment_events.arn`, by an SQS ARN matching the queue's literal `name`, or as `"*"` for every queue. Deny statements and statements with `NotAction` or `NotResource` are left out, and conditions aren't read.

A queue is the target element whose `bearing.terraform` property names its address, e.g. `"bearing.terraform" "aws_sqs_queue.appointment_events"`, or failing that the one element of an SQS technology left when there's one queue left. A queue that matches nothing keeps its address. The node is the container its matched deployment node deploys. A grant reads as `<container>-><queue>` for sending and `<queue>-><container>` for receiving, and is narrowed to the container's components the target declares the relationship with the queue for. In the Chairside example the booking API's role may send to the queue and the reminder worker's may receive from it, and the target declares the event publisher and event consumer as the ends, so the Terraform gives `eventPublisher->appointmentEvents` and `appointmentEvents->eventConsumer`. A container whose components declare nothing with the queue keeps the grant itself, so a new grant reads as a relationship the target doesn't have.

### How traces map to components

`bearing test` loads a Node module hook that wraps the exported functions of every file under a component path and emits a span tagged with that component. Because Bearing already knows the paths from the model, nobody adds instrumentation by hand. Spans are written to `.bearing/traces/` locally and regenerated from scratch in CI.

`bearing test -- <cmd>` clears `.bearing/traces/` and runs the command, or `tests.integration` when none is given, with the hook preloaded into every Node process it starts through `NODE_OPTIONS`. It needs Node.js 22.15 or later.

- **ES modules and CommonJS**: Node's module hooks rewrite each component file as it loads. An ES module's exported functions are rebound to wrappers at the end of the module, so importers, which read live bindings, call the wrapper; a CommonJS module's functions on `module.exports` are replaced once it has run. Re-exports are left to the module that declares the function, and classes aren't wrapped.
- **Vitest** runs code through Vite's module runner rather than Node's loader, so the hook adds the same rewrite as a Vite plugin to every config Vitest resolves. The project's Vitest config is left as it is.
- **Jest** loads each test's modules itself, through its own transform, and runs them in the test environment's `vm` context. The hook swaps `jest-runtime`'s class for one that applies the same rewrite to component files after Jest's transform, as CommonJS or, under Jest's ES module mode, as ES modules, and gives the environment's global its own view of the span runtime. The project's Jest config is left as it is.
- **Spans** are OpenTelemetry spans in the OTLP JSON file format, one file per process. Each carries `bearing.component`, `code.function.name` and `code.file.path`; calls nest under the call that made them, across `await`s, within one trace per test.
- **Criteria**: the running test's full name, which Vitest and Jest keep in their shared matcher state, goes in `bearing.test`, and the tag in it that matches `tests.tag` goes in `bearing.criterion`, e.g. `#2/AC1`. Untagged tests' spans have no criterion, so they never count as evidence. Tests run concurrently within a file share that state, so their spans can be credited to the wrong test.
- **Test outcomes**: once a test finishes, the runner's main process records its full name, file, criterion tag and whether it passed, failed or was skipped, in `.bearing/traces/tests-*.jsonl`. Under Vitest the hook's Vite plugin adds a reporter for this; under Jest it wraps `runCLI` in `@jest/core`, which every way of running Jest goes through. Neither changes the project's own test config.

The overhead, measured on the basket fixture and on date-fns, is in the [README](../README.md#trace-overhead): 17% to 29% more test time.

Go code can't be wrapped as it loads, so for Go `bearing test` rewrites it before the command runs ([ADR 0001](adrs/0001-trace-go-with-an-overlay.md)). It writes instrumented copies of each component's Go files to `.bearing/traces/go/`, with a `defer` at the top of every exported function and every exported method of an exported type. It then adds `-overlay=<file>` to `GOFLAGS`, so every `go test` the command runs builds the copies instead of the files in the working tree, which never change. Line directives keep compile errors and panics pointing at the original lines.

- **Criteria**: each `TestXxx` function and each function literal passed to `t.Run` records how it ended, under its full name, `TestReminders/#3/AC1_sends_a_reminder`. Go writes spaces in subtest names as underscores, so a space in `tests.tag` matches either. A goroutine started by the code under test joins the trace of the test that started it.
- **Cached results**: the go command never replays a cached test result in place of a traced run.
- **Coverage**: the go command builds packages that `-cover` or `-coverpkg` covers from the files on disk, not the overlay, so their calls go untraced. `bearing test` warns when a run collected coverage; run it without.
- **Vendored dependencies** aren't supported yet. A module with `vendor/modules.txt` needs `GOFLAGS=-mod=mod`.
- About 3 µs per traced call. Where the go command downloaded the toolchain into the module cache, Go 1.25 and later won't let the overlay add to the standard library, and goroutine IDs come from stack traces instead, at 10 to 40 µs a call.

Python modules can be wrapped as they're imported, as Node modules are. `bearing test` puts Bearing's `bearing_python` package on `PYTHONPATH` and its pytest plugin in `PYTEST_PLUGINS`, so every pytest the command runs loads the plugin before any test or `conftest.py`. The plugin adds an import hook that compiles each module under a component path from its source with a trace decorator on every public module-level function and every public method of a public module-level class, as `Class.method`. Names starting with an underscore, typing stubs, abstract methods and the methods of a `Protocol` aren't traced.

- **Decorators**: the trace decorator is the innermost, so other decorators get the wrapper: a FastAPI route registers it, and `staticmethod` or `property` wrap it. It keeps the function's kind, plain, coroutine, generator or async generator, and its signature, so frameworks that inspect it see what they'd see without it.
- **Nesting**: calls nest under the call that made them through a context variable, across `await`s and into the worker threads FastAPI and Starlette run sync code in, which copy the context. Bytecode for instrumented modules is never read or written, so nothing in `__pycache__` changes, and tracebacks point at the original lines.
- **Criteria**: each test records how it ended under its pytest node ID, `tests/test_booking.py::test_refuses_a_slot_already_booked`, with the tag from its closest `req` marker. A test passes only if its setup, call and teardown all pass. Tests that run outside pytest, such as in a subprocess the tests start, aren't traced.

#### Traces across a queue

A message sent to a queue and received from it would split one test's trace in two: the code that sends and the code that receives run apart, often in different processes and languages. So the Python and Go hooks carry the trace through SQS messages by default, as W3C Trace Context and W3C Baggage carry it through HTTP headers:

- **Sending**: each `SendMessage` and `SendMessageBatch` records a producer span, named for the queue in `messaging.destination.name`, under the call that sent it. Each message gets two more attributes: `traceparent`, naming that span, and `baggage`, holding `bearing.test` and `bearing.criterion`. An attribute the code set itself is left as it is, and one that would take a message past SQS's limit of 10 is left out. The caller's input is never changed; the hook sends a copy.
- **Receiving**: each `ReceiveMessage` asks for those two attributes as well as the ones the code asked for, and takes them back out of what it returns if the code didn't ask for them. If a message carries a `traceparent`, the hook records a consumer span under the producer span. The traced call that received the message then carries on in the sender's trace and test: the calls it makes next nest under it there, whatever test, if any, the receiving process is running. That way the `#3/AC1` test in the booking API yields one trace through the reminder worker. Received outside a traced call, the next calls the code makes join the trace instead. When a batch's messages came from different traces, the first message's trace wins.
- **Python** patches botocore's client, so boto3 calls are covered, once `botocore.client` loads.
- **Go**: the AWS SDK for Go v2 lives in the module cache, which Go 1.25 and later won't let an overlay change, so the rewrite changes the calls instead. In any file that imports `github.com/aws/aws-sdk-go-v2/service/sqs`, a call such as `client.SendMessage(ctx, input)` becomes `__bt.SQSSendMessage(client.SendMessage, ctx, input)` on the same line, and the same goes for `SendMessageBatch` and `ReceiveMessage`. That covers files outside every component too, such as an adapter package the consumer calls, but not a call through an interface in a file that doesn't import the SQS package.
- The TypeScript hook doesn't carry trace context through queues yet.

#### Traces across HTTP

Services in one Kubernetes cluster call each other over HTTP by a Service's name, such as `http://booking-api:8000/slots`. When `iac.kubernetes` is set, that name says which container a request reaches, so only the caller needs tracing: the tests a team already runs, with no cluster, take the step as long as the code calls the Service's name. The response can be mocked, with `responses` or `respx` for example.

- **Requests**: the trace hooks record a client span for each HTTP request a traced call sends, under that call. It's named for the method and host, e.g. `GET booking-api`, with `http.request.method`, `server.address` and, when the URL gives one, `server.port`. The request goes out as the code made it. A request the test makes itself, outside every traced call, such as through FastAPI's `TestClient` or Go's `httptest`, isn't recorded, since no component sent it. Incoming requests aren't traced, and no headers are added, so the callee's spans don't join the caller's trace.
- **Python** patches `requests.sessions.Session.send` once `requests.sessions` loads, and `Client.send` and `AsyncClient.send` once `httpx` loads. The client span isn't made current, so an app an in-process transport runs, such as one behind httpx's `ASGITransport`, nests under the caller.
- **Services**: a Service reaches the container that the target deployment node of its workloads runs. Its `spec.selector` picks the Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs and Pods in its namespace whose pods carry its labels, and each of those is the node it matched [above](#how-kubernetes-manifests-map-to-deployment-nodes). A Service with no selector, or whose nodes run no container or more than one, reaches nothing. A host names a Service as cluster DNS resolves it: `booking-api`, `booking-api.chairside`, `booking-api.chairside.svc` or `booking-api.chairside.svc.cluster.local`, on no port or one the Service exposes. A host no Service has, such as `localhost` or an external API's, is ignored, and so is a short name two namespaces' Services share.
- **Go**: the standard library can't be changed through the overlay, so the hook wraps transports. In any file that imports `net/http`, the rewrite routes each `http.Client` composite literal's `Transport` through the hook on the same line: `&http.Client{Timeout: d}` becomes `&http.Client{Timeout: d, Transport: __bt.HTTPTransport(nil)}`, and a nil transport is `http.DefaultTransport`, read when the request goes out. Tracing also wraps `http.DefaultClient`'s, which `http.Get`, `http.Post` and the like send through. A client made another way, such as `new(http.Client)` or by a dependency in the module cache, isn't covered, and code that asserts a client's `Transport` is an `*http.Transport` finds the hook's instead.
- **TypeScript**: Node publishes each request it sends on a diagnostics channel, in the context of the code that sent it, so the hook only listens: `http.client.request.start` for `node:http` and `node:https`, and the clients built on them such as axios, and `undici:request:create` for `fetch` and the undici package. The span is written as the request starts.

### How criteria coverage is checked

Criteria coverage reads the test outcomes from the last `bearing test` run. For each criterion of the issues a change works on, it looks at the tests whose names carry that criterion's tag:

- **Covered**: at least one passed and none failed.
- **Failing**: at least one failed, even if another passed.
- **Missing**: none ran. Skipped tests don't count as having run.

A test counts only through the tag in its name, `#2/AC1` by default, which may sit in the test's own name or in a `describe` around it; in Python, through the tag in its `req` marker. A name that mentions the issue some other way, such as `#2 adds an item`, is untagged and never counts. Each test counts for the first tag in its name.

The check fails if any criterion is missing or failing, listing each with its text, the tag to add for a missing one, and the tests that failed. It checks the issues the claims file names, or, if it has none or there's no claims file, the ones in the branch name. Issues given as arguments, `bearing check 2 4`, replace both.

If that leaves no issues, it fails when the branch changes source files in a component, naming the components, since code in a component has to serve an issue. That holds for a human's refactor too. A branch that only changes the model, Terraform or files outside every component skips it, and Trace paths with it.

### How requirement changes are caught

The target and the tests are written against an issue's criteria as they stood at the time, so `bearing validate` keeps them in step as issues change. Bearing reads the issues afresh on every run; nothing listens for GitHub's issue events.

- **Criteria edited.** Each story's dynamic view pins its criteria in `bearing.criteria`: a short digest of each criterion's text, such as `"AC1:3f2a9c1e,AC2:9b1c04d7"`, which `bearing context` prints. Whitespace is collapsed first, so rewrapping a criterion doesn't change it, and the story, the title and anything outside the criteria aren't pinned. When the pin stops matching, validation fails on the view, saying which criteria were edited, added or removed and naming the tests tagged with them as stale, with the pin to set once they're checked. Updating the pin changes the model, so the guard flags it as a target change and merging it approves the refresh. A view with no pin fails the same way.
- **Closed.** An element or relationship that lists a closed issue fails validation. What listed only issues closed as not planned is listed for pruning, components with the path whose code to delete, and so is the issue's dynamic view; what lists open issues too is told to drop the closed one. Until the prune merges, Surplus flags the code of each component that serves only closed issues, whatever traces it; once it's pruned, that code is outside every component and is flagged as such until it's deleted. A requirement issue stays open for as long as the code serves it, so PRs link to one with `Refs #n` rather than `Closes #n`. Closing one as completed fails the elements and view that list it, with the fix to reopen it, since the code still serves it; dropping it from the model would only hide that.

### How `bearing check` works

`bearing check` runs the blocking checks below on the code as it is on disk and exits non-zero if any fails. Each one passes, fails or is skipped when there's nothing for it to check; a skipped check never fails. `--json` prints every check's result, with the IDs, files and lines behind each failure, for `bearing report`.

The target they compare against depends on the branch. A branch that changes the model's folder is checked against its own, proposed target. Any other branch is checked against main's current target, read from git, so a target change merged after it forked applies to it straight away.

- **Target valid** applies `bearing validate`'s rules to the target the branch is checked against, and fails on each one it breaks. A new requirement with no dynamic view yet fails it, on every branch, until a target change covers it. Structurizr's own validation has already passed, or the target wouldn't load.
- **Target change** passes a branch that changes the model's folder when main's model folder hasn't changed since the branch forked, and fails it, listing main's changed files, when it has: the first target change to merge wins, and a later one must rebase onto it and rework its change on top. Two proposals can edit different parts of the model without a Git conflict, so this check, not Git, is what makes the later one rework its change. A branch that doesn't change the target skips it.
- **Claim** reads the branch's claims file on top of the target as it stood where the branch forked from main, and fails on each mismatch with the as-built model:
  - a relationship the code makes that the target didn't have at the fork point and the claim doesn't add;
  - something the claim removes that the code still has: a relationship it still imports or the Terraform still allows, or files left under a removed component's path;
  - a changed source file the claim doesn't list, a listed file the branch doesn't change, or a file claimed for a component other than the one whose path holds it.

  An addition the code doesn't make yet isn't a mismatch, since the target may lead the code. A branch with no claims file, such as a human's Terraform PR, skips this check.
- **Boundaries** fails each relationship between two components that the code makes and the target doesn't declare, listing the imports that make it, and each relationship through a queue that the Terraform allows and the target doesn't declare, listing the IAM statements that allow it. Anything inside one component passes.
- **Deployment** compares the nodes `bearing derive` reads from the Terraform or the Kubernetes manifests with the target's deployment view, and fails on a node the target doesn't have, a target node with no resource, or an instance count that differs. Resources Bearing doesn't map are listed but never fail it. It's skipped when neither `iac.terraform` nor `iac.kubernetes` is set.
- **Criteria coverage** is the check above.
- **Trace paths** compares the traces of an issue's passing tagged tests with its dynamic view. A story has one view but its criteria can take different parts of it, so each test must follow an unbroken run of the view's steps, in order, with no call into a component the view doesn't declare between them, and together the story's tests must take every step. A step no test takes fails the view. A run that stops short of the view's end is checked for those undeclared calls to the end of its trace. Any call in the trace between two components the target declares no relationship for also fails it, even if a later read-back takes the view's steps. That catches a shortcut imports can't show, such as through a port the caller is handed. A call the target declares but the view doesn't draw passes, since setup and read-back run them.

  A view's steps into and out of a queue are part of its path, since the hooks' messaging spans [carry the trace across it](#traces-across-a-queue). A messaging span stands for the queue whose literal `name` in the Terraform is the span's queue name, or, when the Terraform names no queue, the target's only element of an SQS technology. A queue neither gives reads as one the target doesn't have, so sending to it fails the test. The test can stand in for a queue as it does for the step into the system: a step from a queue into a component matches a call into that component from the test, as when the test hands the consumer its messages. A step from a component into a queue needs the messaging span, so a test that replaces the queue client with a fake doesn't take it.

  A view can also say how containers work together, such as `webApp -> bookingApi "Books the slot"`. A step between two containers is part of its path when the source container has components, the Kubernetes manifests have a Service that [reaches](#traces-across-http) the destination, and the target's relationship between them is over HTTP: its technology mentions HTTP, HTTPS or REST. A step over SQL to a database isn't. A request to the Service's name stands for a call from the component that sent it into the container, and a call takes a step when each of its ends is the step's element or one of its components, so the web app's API client calling the booking API takes `webApp -> bookingApi`. A view that names a container declares its components with it. A request into a container passes the relationship check when the target relates the caller, or the caller's container, to it. Each service's tests take their own steps, so the web app's tests take `webApp -> bookingApi` and the booking API's take the steps from there; the test can't stand in for the caller on a step between containers. Bearing confirms each side does its part, not that the booking API answers what the web app's mock expects: that's contract testing's job.

### How `bearing report` works

`bearing report` writes the PR comment in Markdown and prints it; `--post` puts it on the PR, editing Bearing's comment from an earlier run rather than adding another, so each PR has one. It runs the checks itself, or reads what `bearing check --json` wrote with `--check <file>`, and never fails on a failing check: `bearing check` does that. The comment has, in order:

- **Target change**, only in target-change mode: the files that put the PR in it, then what the PR changes about the architecture, in the order a reviewer reads it.
  - A summary in plain words, generated from the model diff.
  - One Mermaid flowchart per C4 level that changed, each with a heading saying what it shows: the system context, the containers, the components of each container, and each deployment environment. Each draws what changed at that level and its direct neighbours, with relationships lifted to the level. Green is added, grey and dashed removed, amber changed. It stops adding neighbours at 15 elements and says how many it left out; what changed is always drawn.
  - A sequence diagram for each new or changed dynamic view, with before and after for a changed one. The first is open, the rest folded, and all are folded past three.
  - The model diff table, then the ADRs the PR adds or changes, in full, as the proposal's reason and alternatives. A model diff with no ADR says so.

  An item whose only change is the requirements it lists is left out of all of that but one line under the table, e.g. "19 elements and relationships now also serve #5". A first design isn't a diff: with no target at the fork point, the summary counts what it defines, the model's context, containers, components and deployment are drawn plain, and the dynamic views and the table are folded. A PR is in target-change mode when it changes the model's folder, `.bearing/` other than claims files, or `.github/workflows/`.
- **Checks**: one row per check with its result and what it found.
- **Overlay**: one Mermaid flowchart of where the code or the Terraform drifts from the target. Red is what drifted: a relationship the code makes that the target doesn't declare, a deployment node the Terraform adds, lacks or counts differently, or a call a tagged test made that its issue's dynamic view doesn't have. Around them it draws the target's relationships between the elements shown, the steps of a view no test took, and the component an undeclared relationship skips, stopping at 15 elements.
- **Details** of each failing or flagged check, as `bearing check` prints them, and the changed source files with the component each landed in. They're dropped if the comment would be too long for GitHub, and the sequence diagrams after them if it still would be.

The guard job writes its own section above all of this when the PR changes the target, and `--post` keeps it there; see below. Its diffs are folded, so the diagrams are the first thing a reviewer reads, and it stays on top because everything under it comes from the PR's own run: an unclosed fence or HTML comment there could swallow anything placed below it.

`--site <dir>` exports the PR's target as Structurizr's static site for the Action to upload as a build artifact, and the comment links to it: by default the Actions run's page, which lists its artifacts, or `--site-url`.

### The architecture page

`bearing page` writes one HTML file for the human reviewing the PR, with everything inlined and nothing loaded from outside it. It leads through four questions as tabs over one map of the architecture: **Target**, did the target change; **Code**, where the code changed, as a heatmap of functional lines changed; **Build**, where the as-built architecture drifts from the target; and **Behaviour**, whether the tagged tests take each dynamic view's steps. Each tab's counter is its checks' result. Below them, the C4 levels drill down from the system context to each container's components, in Change, Before, After and Drift modes, with each element's details on the side. The same inputs give the same file byte for byte. `--check` reads `bearing check --json` output rather than running the checks again.

In CI, the conformance job builds the page as its last step and uploads it as a single, unzipped artifact, and the report job links it from the top of the report part of Bearing's comment:

- **The link opens the page.** It's the artifact's github.com URL, which checks the reader can see the repo, then redirects to a short-lived signed URL on GitHub's Actions storage, `productionresultssa*.blob.core.windows.net`, served as `text/html`. So it opens in the browser with no download and no unzip, and works for private repos. Share the link in the comment, never the storage URL. A network that allow-lists hosts needs GitHub's Actions storage on the list; most already have it, as their own runners need it.
- **It lasts as long as the repository keeps artifacts,** 90 days unless changed. The conformance action's `retention-days` input sets it, up to that limit.
- **A page that fails to build never fails the job:** the comment then says nothing about a page.
- **Only for a PR from the same repo.** A fork's run builds no page and the comment links none, since the PR's author could have written any HTML.
- **None for a PR that changes Bearing itself,** in `.github/workflows/` or `.bearing/` other than claims files: the page would be built by the very workflow it changes. The conformance job doesn't build one, and `bearing post` checks the PR's files itself through the API, as the guard does, and never links one for such a PR, whatever the run uploaded. The comment says why instead, and the guard's diffs above it are the authoritative view. A PR that changes only the target model still gets its page.

### The GitHub Action

The Action's job is to prove the agent hasn't made things up or silently moved the target. CI re-derives everything and trusts nothing the branch provides: no committed as-built model, trace or test result is used.

*[Embedded diagram: Bearing's GitHub Action · 2 jobs, 3 status checks]*

The guard runs from the base branch and never executes PR code, so a PR can't disable it; the conformance job runs the PR's code but has no secrets.

- **Guard job** (`pull_request_target`): runs `bearing guard`, which reads the PR's changed files through the API, with no checkout. Changes under the model's folder (as the base branch's config sets it), `.bearing/` other than claims files, or `.github/workflows/` label the PR `architecture-change`, put each changed file's diff in a section at the top of Bearing's comment, folded and marked as the authoritative change, and say so in `bearing/target`. The guard reports: `bearing/target` is always a success, so it never blocks a merge on its own; merging approves the change, and code-owner review is where a team holds one. When a later push stops changing the target, the label and the section go. The guard only edits a comment the Actions bot wrote, and the report keeps the guard's section when it updates the comment.
- **Conformance job** (`pull_request`): runs `bearing test`, `bearing derive`, `bearing check` and `bearing report`, with a read-only token for reading the requirement issues. It clears any committed traces first, so `bearing test` writes them afresh. It fails, and with it `bearing/conformance`, when the target is invalid or a blocking check fails; a failing test fails it through Criteria coverage. It can't comment, since a PR from a fork never gets a token that can write, so it uploads the comment, the check results and the PR's number as the `bearing-report` artifact, and the Structurizr site as `bearing-site`. Last, for a PR from the same repo that leaves Bearing's workflows and config alone, it runs `bearing page` and uploads the architecture page unzipped, as `bearing-architecture.html`; see The architecture page.
- **Report job** (`workflow_run`, once the conformance workflow completes): runs from the default branch with a token that can write and never checks out the PR. `bearing post` reads the upload as untrusted, since the PR's code wrote it: it posts only when the PR it names is still at the commit the conformance run checked, so an upload can't comment on another PR and an older run can't overwrite a newer one. It writes the report part of Bearing's comment, keeping the guard's section, and can't forge or close that section. It links the run's architecture page at the top of the report, only for a PR from the same repo that doesn't change Bearing's workflows or config, which it checks itself. It sets `bearing/advisory`, always a success, to what Surplus flagged.
- **Target compared**: main's target normally; the PR's proposed target when it changes the model. The conformance job checks out the PR's head with its history rather than GitHub's merge commit, so Bearing can find where the PR forked and tell whether main's target moved since.
- **The Action**: each job is a composite action in Bearing's repo, `actions/guard`, `actions/conformance` and `actions/report`, versioned by Bearing's release tags. Each runs the `bearing-cli` release its tag names. The workflows `bearing init` writes use the actions at init's own version, as in `My5t3ryMach1n3/bearing/actions/conformance@v0.1.0`; the conformance workflow checks out the PR and installs the project's dependencies before it.

**Repo settings `bearing init` asks you to turn on**

- [ ] Branch protection on main: require a pull request.
- [ ] Required status checks: `bearing/target` and `bearing/conformance`.
- [ ] Optional, for teams that want a second reviewer on target changes: CODEOWNERS entries for architecture/, .bearing/ and .github/workflows/ (`bearing init --owner`), with code-owner review required.
- [ ] Optional, on organisation plans with rulesets: make the conformance workflow a required workflow sourced from main.


## Walkthrough: a greenfield service

A two-person team builds a basket service with coding agents, and never loses track of what the agents built or why. The people and the service are illustrative; the tool is Bearing.

### Monday: requirements in, architecture out

Priya, the tech lead, starts with an empty repository and six GitHub issues. Each uses the `requirement` issue form: a user story and numbered Given/When/Then acceptance criteria. Issue #4 reads: as a shopper, I want my basket restored after my session expires, so that I don't lose it.

She asks her coding agent to design from the open requirements. Following the instructions Bearing installed, the agent pulls the six issues and the C4 rules with bearing context and, twenty minutes later, opens a pull request containing only a Structurizr workspace:

- A system context with the shopper, the basket system, the identity provider and the product catalogue.
- Containers for the web app, the basket API and a Postgres database.
- Five components inside the basket API, each owning a folder under `src/basket-api/`.
- One dynamic view per issue, and a deployment view describing the planned AWS setup.

Every box and arrow lists the issue numbers it serves. Nothing exists "just in case".

### Monday afternoon: review in Structurizr

Priya opens the workspace in Structurizr and walks the dynamic views one issue at a time. Two things bother her. For #4, the agent added a Redis cache to hold expired baskets; she doesn't want a second datastore for six stories. And the session-restore component calls the identity provider directly, bypassing the auth middleware every other component uses.

She leaves both as review comments. The agent revises: baskets persist in Postgres, and session restore goes through the middleware. Sam, the other engineer, checks that the component split makes sense for the work he'll own. Priya approves as code owner of the model files, and the workspace merges to main. That commit is now the desired state.

### Tuesday: the first governed PRs

Sam points two agents at issues #1 and #2. Each agent loads the slice of the model its issue touches before writing anything.

The PR for #2 arrives with code, integration tests tagged `#2/AC1` and `#2/AC2`, and the agent's claimed model diff: no structural changes. The checks disagree. The as-built model, extracted from the TypeScript imports, shows the basket controller importing the repository directly, a relationship the target doesn't declare. The claim didn't match reality, and the boundary was crossed.

The PR comment shows one small overlay: the controller, the service, the repository, and a red arrow skipping the middle. The agent self-heals on its second attempt and routes the call through the service. All checks go green.

The trace check confirms it. The OpenTelemetry spans from `#2/AC1`, mapped to components by file path, follow exactly the path in issue #2's dynamic view.

One amber flag remains: a `retryWithBackoff` helper that sits in the right folder but that no requirement's test ever reaches. It's flagged for review, not blocking. Sam reads it, agrees it's speculative, and deletes it before merging.

### Wednesday: when the target is wrong

Issue #5 asks for sharing a basket with another shopper by email. The agent tries to fit it into the existing components and can't: nothing in the target sends outbound messages, and there is no relationship to an email provider.

After its retries run out, the agent adds the change to the model in the same branch: a new share component, a new external email provider, and a relationship between them, with a short rationale and the alternative it rejected (building email sending into the basket service).

Because model files changed, the PR switches into target-change mode. It gets the `architecture-change` label, the model diff sits at the top of the PR comment, and, because the team turned on code-owner review for the model, merge waits for Priya. Priya accepts the new component but asks for the email call to be asynchronous, so a slow provider can't hold up the basket API. The agent updates both the model and the code. She approves, and target and code merge together.

### Thursday: a human drifts too

Sam, chasing a latency worry, opens a Terraform PR that adds a Redis cluster. The deployment check flags it straight away: the as-built deployment, parsed from the Terraform, contains a node the target doesn't have, the same Redis Priya rejected on Monday. The rules are the same for humans. Sam can either propose the target change and argue for it, or drop it. He drops it and opens an issue to measure latency first.

### Two weeks later: a new requirement

Product asks for guest baskets: shoppers who haven't signed in. Priya files issue #9 with three acceptance criteria. Her agent reads the target and the code, and proposes a diff: the session-restore component gains a responsibility, one relationship changes, and #9 gets a new dynamic view. Everything else is untouched.

Priya reviews the diff in Structurizr, approves it, and the agents implement against the updated target. When the PR lands, the traces from `#9/AC1` to `#9/AC3` match the new dynamic view.

### What the team has at the end

On Friday, Priya opens Structurizr on main. Target and as-built are in sync. Every issue has a dynamic view verified by its own tests' traces. Every architectural decision made since Monday, whether by her, by Sam or by an agent, is a reviewed diff with a reason attached.

The tests tell her what the system does. The model tells her how it does it, where each piece lives, and that it's still the system they agreed to build.
