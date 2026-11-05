import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";

// The Config example from the spec's How it works section.
const specExample = `version: 1
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
  terraform: infra/
agent:
  selfHealAttempts: 3
checks:
  surplus: advisory
  responsibilities: advisory
`;

function problems(text: string): string[] {
  try {
    parseConfig(text, "/repo");
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
  it("loads the spec example", () => {
    expect(parseConfig(specExample, "/repo")).toEqual({
      root: "/repo",
      version: 1,
      model: "architecture/workspace.dsl",
      structurizr: { runner: "docker" },
      languages: [{ name: "typescript", root: ".", project: "tsconfig.json" }],
      requirements: { source: "github-issues", label: "requirement" },
      tests: { integration: "npm run test:integration", tag: "#<issue>/AC<n>" },
      iac: { terraform: "infra/" },
      agent: { selfHealAttempts: 3 },
      checks: { surplus: "advisory", responsibilities: "advisory" },
    });
  });

  it("fills defaults for everything but version, model and language", () => {
    const config = parseConfig("version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\n", "/repo");
    expect(config).toEqual({
      root: "/repo",
      version: 1,
      model: "architecture/workspace.dsl",
      structurizr: { runner: "docker" },
      languages: [{ name: "typescript", root: ".", project: "tsconfig.json" }],
      requirements: { source: "github-issues", label: "requirement" },
      tests: { tag: "#<issue>/AC<n>" },
      iac: {},
      agent: { selfHealAttempts: 3 },
      checks: { surplus: "advisory", responsibilities: "advisory" },
    });
  });

  it("names a misspelled top-level key and its line", () => {
    expect(problems(specExample.replace("tsconfig:", "tsconfg:"))).toEqual(['line 6: unknown key "tsconfg"']);
  });

  it("names a misspelled nested key by its full path", () => {
    expect(problems(specExample.replace("selfHealAttempts", "selfHealAttempt"))).toEqual([
      'line 16: unknown key "agent.selfHealAttempt"',
    ]);
  });

  it("names missing required keys", () => {
    expect(problems("version: 1\n")).toEqual([
      'missing required key "model"',
      'missing required key "language" or "languages"',
    ]);
  });

  describe("languages", () => {
    const base = "version: 1\nmodel: architecture/workspace.dsl\n";

    it("lists each language with its root and project file", () => {
      const text = `${base}languages:
  - name: typescript
    root: services/web/
  - name: typescript
    root: ./services/api
    project: tsconfig.build.json
  - name: typescript
  - name: go
    root: services/reminder-worker
`;
      expect(parseConfig(text, "/repo").languages).toEqual([
        { name: "typescript", root: "services/web", project: "tsconfig.json" },
        { name: "typescript", root: "services/api", project: "tsconfig.build.json" },
        { name: "typescript", root: ".", project: "tsconfig.json" },
        { name: "go", root: "services/reminder-worker", project: "go.mod" },
      ]);
    });

    it("reads language and tsconfig as one language at the repo root", () => {
      expect(parseConfig(`${base}language: typescript\ntsconfig: tsconfig.app.json\n`, "/repo").languages).toEqual([
        { name: "typescript", root: ".", project: "tsconfig.app.json" },
      ]);
    });

    it("takes language or languages, not both", () => {
      expect(problems(`${base}language: typescript\nlanguages:\n  - name: typescript\n`)).toEqual([
        'line 4: "language" and "languages" can\'t both be set; list every language under "languages"',
      ]);
      expect(problems(`${base}tsconfig: tsconfig.json\nlanguages:\n  - name: typescript\n`)).toEqual([
        'line 3: "tsconfig" only goes with "language"; under "languages", set each one\'s "project"',
      ]);
    });

    it("rejects unknown languages and keys, and an empty list", () => {
      expect(problems(`${base}languages:\n  - name: cobol\n    rot: x\n`)).toEqual([
        'line 5: unknown key "languages.0.rot"',
        'line 4: "languages.0.name" must be one of: typescript, go, python',
      ]);
      expect(problems(`${base}languages: []\n`)).toEqual(['line 3: "languages" must NOT have fewer than 1 items']);
    });

    it("rejects a language listed twice at one root, and roots outside the repo", () => {
      const text = `${base}languages:\n  - name: typescript\n  - name: typescript\n    root: ./\n  - name: typescript\n    root: ../other\n`;
      expect(problems(text)).toEqual([
        'line 5: typescript is listed twice at root "."',
        'line 8: "languages.2.root" must be inside the repo',
      ]);
    });
  });

  it("rejects languages Bearing has no adapter for", () => {
    expect(problems(specExample.replace("language: typescript", "language: java"))).toEqual([
      'line 5: "language" must be one of: typescript, go, python',
    ]);
  });

  it("rejects other config versions", () => {
    expect(problems(specExample.replace("version: 1", "version: 2"))).toEqual(['line 1: "version" must be 1']);
  });

  it("reports every problem at once", () => {
    const text = specExample.replace("runner: docker", "runner: podman").replace("surplus: advisory", "surplus: loud");
    expect(problems(text)).toEqual([
      'line 4: "structurizr.runner" must be one of: docker, java',
      'line 18: "checks.surplus" must be one of: advisory, off',
    ]);
  });

  it("rejects a non-positive self-heal limit", () => {
    expect(problems(specExample.replace("selfHealAttempts: 3", "selfHealAttempts: 0"))).toEqual([
      'line 16: "agent.selfHealAttempts" must be >= 1',
    ]);
  });

  it("requires both placeholders in the test tag", () => {
    expect(problems(specExample.replace('"#<issue>/AC<n>"', '"#<issue>"'))).toEqual([
      'line 12: "tests.tag" must contain both <issue> and <n>',
    ]);
  });

  it("reports YAML syntax errors with a line", () => {
    expect(problems("version: 1\nmodel: [unclosed\n")[0]).toMatch(/^line \d+: /);
  });

  it("rejects an empty file", () => {
    expect(problems("")).toEqual([
      'missing required key "version"',
      'missing required key "model"',
      'missing required key "language" or "languages"',
    ]);
  });
});

describe("loadConfig", () => {
  it("finds the config from a subdirectory of the repo", () => {
    const root = mkdtempSync(join(tmpdir(), "bearing-config-"));
    mkdirSync(join(root, ".bearing"));
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, ".bearing", "config.yaml"), specExample);
    expect(loadConfig(join(root, "src", "deep")).root).toBe(root);
  });

  it("says where the bad config file is", () => {
    const root = mkdtempSync(join(tmpdir(), "bearing-config-"));
    mkdirSync(join(root, ".bearing"));
    writeFileSync(join(root, ".bearing", "config.yaml"), "version: 1\nmodel: x\nlanguage: typescript\nmodle: y\n");
    expect(() => loadConfig(root)).toThrow(/^\.bearing\/config\.yaml:\n {2}- line 4: unknown key "modle"/);
  });

  it("explains when there is no config", () => {
    const dir = mkdtempSync(join(tmpdir(), "bearing-config-"));
    expect(() => loadConfig(dir)).toThrow(/not found in .* run `bearing init`/);
  });
});
