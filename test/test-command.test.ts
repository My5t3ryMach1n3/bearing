import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { resolveTestCommand } from "../src/test.js";

// A repo with the given config lines under `tests:` and, unless it's undefined, the given package.json.
function repo(tests: string, packageJson?: string) {
  const root = mkdtempSync(join(tmpdir(), "bearing-test-command-"));
  if (packageJson !== undefined) writeFileSync(join(root, "package.json"), packageJson);
  const config = parseConfig(
    `version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\ntests:\n${tests}\n  tag: "#<issue>/AC<n>"\n`,
    root,
  );
  return config;
}

const withScript = JSON.stringify({ scripts: { "test:integration": "vitest run" } });

describe("resolveTestCommand", () => {
  it("runs the command given after --, over the config and package.json", () => {
    const config = repo("  integration: npm run it", withScript);
    expect(resolveTestCommand(config, ["npx", "vitest"])).toEqual({ command: ["npx", "vitest"], fallback: false });
  });

  it("runs tests.integration when it's set, over package.json", () => {
    const config = repo("  integration: npm run it", withScript);
    expect(resolveTestCommand(config)).toEqual({ command: ["npm run it"], fallback: false });
  });

  it("falls back to package.json's test:integration script when tests.integration isn't set", () => {
    const config = repo("  # integration: npm run test:integration", withScript);
    expect(resolveTestCommand(config)).toEqual({ command: ["npm run test:integration"], fallback: true });
  });

  it.each([
    ["no package.json", undefined],
    ["a package.json that isn't JSON", "{"],
    ["no scripts", "{}"],
    ["other scripts only", JSON.stringify({ scripts: { test: "vitest run" } })],
  ])("has no command with %s", (_, packageJson) => {
    expect(resolveTestCommand(repo("  # integration: npm run test:integration", packageJson))).toBeUndefined();
  });
});
