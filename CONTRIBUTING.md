# Contributing to Bearing

Thanks for helping. Bearing is early, so the [issues](https://github.com/My5t3ryMach1n3/bearing/issues) are the plan: pick one whose "Depends on" issues are closed, or open a new one before starting something that isn't tracked.

## Setup

You need Node.js 22 or later.

```sh
npm install
npm run build
node dist/cli.js --help
```

To try the `bearing` command from anywhere, run `npm link` once; it points the global `bearing` at your checkout's `dist/`, so rebuild after each change.

## Checks

CI runs these on every pull request, and they should pass locally first:

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run format:check` | Prettier (`npm run format` fixes it) |
| `npm run typecheck` | TypeScript over `src/` and `test/` |
| `npm test` | Vitest unit tests |
| `BEARING_STRUCTURIZR_RUNNER=docker npx vitest run test/structurizr.integration.test.ts` | Converts the fixture models with the real Structurizr (needs Docker, or Java 21 with `=java`) |

## Layout

- `src/cli.ts` is the `bearing` bin. It only parses the command line.
- `src/program.ts` builds the command tree. A new subcommand goes in its own module under `src/` and is registered in the `commands` list there.
- `src/config.ts` finds, validates and loads `.bearing/config.yaml`. Commands get their settings from `loadConfig()` rather than reading the file themselves.
- `src/structurizr.ts` turns the model's DSL into workspace JSON with the pinned Structurizr release, via Docker or Java as `structurizr.runner` says, and caches the result by a hash of the model directory. It is the only code that runs Structurizr.
- `src/model.ts` reads workspace JSON into the internal model that the target, the as-built model and claims share. Elements, relationships, dynamic views and deployment elements are keyed by stable IDs (DSL identifiers, not Structurizr's numeric IDs), so editing a description reads as drift rather than a removal.
- `src/diff.ts` diffs two models into added, removed and drifted items, and is the `bearing diff <before> <after>` command, which prints that diff as JSON.
- `src/init.ts` is `bearing init`. It writes the files under `templates/init/`, which mirror where they land in the repo and ship in the package beside `dist/`, and only ever creates missing files or appends Bearing's part to AGENTS.md, .gitignore and CODEOWNERS. CODEOWNERS is opt-in: entries are only written for owners given with `--owner`.
- `src/requirements.ts` loads the requirements: GitHub issues with the `requirements.label` label, each parsed into its story and criteria (`#4/AC2`). It reads them through GitHub's GraphQL API, which says which issues are epics, using `GITHUB_TOKEN` and `GITHUB_REPOSITORY` in CI or `gh auth token` and the origin remote locally. Set `BEARING_ISSUES_FILE` to a JSON file of REST-shaped issues, such as `test/fixtures/basket/issues.json`, to read that instead.
- `src/context.ts` is `bearing context`, the agent's view of the work. `--issues` prints the open requirements with the C4 rules, Bearing's rules and the DSL conventions; `bearing context <n>` prints the slice of the target issue `#n` touches: its criteria, its dynamic view (keyed `req-<n>`), and the components and relationships that list it or that the view passes through. `--json` prints either as JSON.
- `src/validate.ts` is `bearing validate`, the Target valid check. Loading the model through Structurizr applies its validation; on top of that, every element and relationship must list an open requirement, every component a `bearing.path` that overlaps no other, every open story that isn't an epic its `req-<n>` dynamic view (and no view may belong to anything else), and every dynamic view step a declared relationship rather than one Structurizr implies. It exits non-zero listing every broken rule; `--json` prints them for `bearing check`.
- `src/claims.ts` is `bearing claim` and the claims file's schema. It drafts `.bearing/claims/<branch>.yaml` from git: the changed source files with their components, and the elements and relationships the target gains or loses, loading the target as the fork point had it from that commit's model folder. `readClaim()` reads a branch's file for the Claim check.
- `src/test.ts` is `bearing test`, which runs the tests with the trace hook in `src/trace/` preloaded. `register.ts` is the preload: it installs the span runtime (`runtime.ts`) and a module hook that applies `transform.ts` to component files, adds the same transform to Vitest as a Vite plugin (`vite.ts`), and to Jest through a subclass of its runtime (`jest-runtime.ts`). The Vite plugin also adds a reporter that records each test's outcome, and `jest.ts` does the same for Jest by wrapping `runCLI`. The hook runs inside the test processes, so it imports only what it needs and loads TypeScript lazily. `test/trace.test.ts` builds it into `node_modules/.cache/` to preload it.
- `src/coverage.ts` is the Criteria coverage check, run as `bearing check <issues...>` until `bearing check` gathers every check: it reads the test outcomes `bearing test` recorded and lists each criterion of the given issues as covered, missing or failing.
- `test/` holds the unit tests. `test/structurizr.integration.test.ts` runs the real Structurizr and is skipped unless `BEARING_STRUCTURIZR_RUNNER` is `docker` or `java`; CI runs it with both. It also checks that `test/fixtures/diff/{before,after}.json` and `test/fixtures/basket/workspace.json` are still what Structurizr exports from their DSL; after editing that DSL, re-export the JSON with the pinned Docker image.
- `test/fixtures/basket/` is the basket service from the spec's walkthrough: a clean repo, its requirement issues, and seeded broken branches as overlays. M1 features are tested against it; its [README](test/fixtures/basket/README.md) says what each variant should trip. The root Vitest run skips its own tests; `test/basket.test.ts` runs them in a copy.

## Pull requests

- Every change lands through a pull request against `main`; nothing is pushed to `main` directly.
- Branch off the latest `main`, keep each PR to one issue, and link it with `Closes #N` in the description.
- Add or update tests with the behaviour they cover.

## Releases

The [release workflow](.github/workflows/release.yml) publishes `bearing-cli` to npm when a `v*` tag is pushed. It uses npm trusted publishing, so there is no npm token to manage, and it refuses to publish if the tag doesn't match the version in `package.json`.

To cut a release:

1. Open a PR that bumps `version` in `package.json` (and `package-lock.json`), e.g. with `npm version 0.1.0 --no-git-tag-version`, and merge it.
2. Tag the merge commit on `main` and push the tag:
   ```sh
   git checkout main && git pull
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Watch the Release run in the Actions tab; when it passes, the version is on npm.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
