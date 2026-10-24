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

## Layout

- `src/cli.ts` is the `bearing` bin. It only parses the command line.
- `src/program.ts` builds the command tree. A new subcommand goes in its own module under `src/` and is registered in the `commands` list there.
- `src/config.ts` finds, validates and loads `.bearing/config.yaml`. Commands get their settings from `loadConfig()` rather than reading the file themselves.
- `test/` holds the unit tests.

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
