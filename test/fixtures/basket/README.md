# Basket fixture

The basket service from the spec's [walkthrough](../../../docs/product-spec.md#walkthrough-a-greenfield-service), built so that every M1 issue has a known input and a known right answer. It is the state at the end of a clean run: the approved target is on main, and all six requirements are implemented in the components the target gives them.

| Path | What it is |
| --- | --- |
| `issues.json` | The six `requirement` issues, shaped like GitHub's REST API returns them, for fixture mode in [#7](https://github.com/My5t3ryMach1n3/bearing/issues/7) |
| `repo/` | The clean repo: what main looks like |
| `workspace.json` | `repo/architecture/workspace.dsl` as the pinned Structurizr exports it, so unit tests can read the target without running Structurizr |
| `variants/<name>/` | The seeded broken branches, as files laid over `repo/` |

## The repo

- `architecture/workspace.dsl` is the approved target. It has the system context, containers (web app, basket API, Postgres), five components under `src/basket-api/` with their `bearing.path`, one dynamic view per requirement, and the AWS deployment view. Every element and relationship lists the issues it serves.
- `src/basket-api/` has one folder per component. Each exports plain functions taking their dependencies as a `ports` argument, so the trace hook ([#13](https://github.com/My5t3ryMach1n3/bearing/issues/13)) sees every call. There is no server entry point: it would sit outside every component and show up as surplus.
- `test/integration/` has one file per requirement, each test named with its tag (`#2/AC1 ...`). Postgres, the identity provider and the product catalogue are in-memory stand-ins in `test/support/app.ts`. `test/unit/` has one untagged test that must never count as evidence.
- `infra/` is Terraform matching the deployment view. It is only parsed, never applied.
- `.bearing/config.yaml` is the spec's example config.

Requirements are #1 to #4, #6 and #7. #5 is the walkthrough's share-by-email story, filed on Wednesday to force a target change; it arrives with [#21](https://github.com/My5t3ryMach1n3/bearing/issues/21).

## Variants

Each variant is a PR against main that breaks one thing and still passes its own tests. Agent variants carry an honest claims file, except where the claim is the thing that's wrong.

| Variant | What it does | What should catch it |
| --- | --- | --- |
| `controller-imports-repository` | The controller saves new items through the repository itself, skipping the service. Its claim says nothing structural changed | Boundaries and Claim: an undeclared `basketController -> basketRepository` |
| `redis-node` | A human adds an ElastiCache Redis cluster in `infra/cache.tf`, the cache the target rejected. No claims file | Deployment: a node the target doesn't have |
| `untraced-helper` | Adds `retryWithBackoff` to the basket service's folder, where nothing calls it | Surplus (advisory): code no criterion's trace reaches |
| `wrong-place` | Moves adding an item into session restore, whose declared relationships let the imports through, and duplicates the catalogue type to avoid importing it | Trace paths: `#2` runs controller, session restore, repository instead of its dynamic view |

## Using it in tests

`copyBasket()` in [`test/basket.ts`](../../basket.ts) copies `repo/` to a temp directory, lays a variant over it if given, and links Bearing's `node_modules` so the copy's own scripts run without an install. [`test/basket.test.ts`](../../basket.test.ts) checks the fixture is still consistent: every component path exists, every requirement has a dynamic view, every criterion has exactly one tagged test, and main and every variant typecheck and pass their tests.

When you change `repo/`, check the variants still apply: a variant replaces whole files, so an edit to `basket-controller/index.ts` or `session-restore/index.ts` usually needs making in the variants' copies too.
