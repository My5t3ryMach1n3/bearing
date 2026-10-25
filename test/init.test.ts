import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigError, loadConfig } from "../src/config.js";
import { formatResult, init } from "../src/init.js";

function emptyRepo(remote = "https://github.com/acme/shop.git"): string {
  const root = mkdtempSync(join(tmpdir(), "bearing-init-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
  return root;
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

const scaffolded = [
  ".bearing/config.yaml",
  "architecture/workspace.dsl",
  "architecture/adrs/.gitkeep",
  ".bearing/claims/.gitkeep",
  ".github/ISSUE_TEMPLATE/requirement.yml",
  ".github/workflows/bearing-guard.yml",
  ".github/workflows/bearing-conformance.yml",
  ".gitignore",
  "AGENTS.md",
  ".github/CODEOWNERS",
];

describe("init", () => {
  it("scaffolds the spec's repo layout in an empty repo", () => {
    const root = emptyRepo();
    const { actions, repo } = init(root);
    expect(actions.map(({ path, outcome }) => [path, outcome])).toEqual(scaffolded.map((path) => [path, "created"]));
    expect(repo).toBe("acme/shop");
    expect(loadConfig(root)).toMatchObject({ model: "architecture/workspace.dsl", tests: { tag: "#<issue>/AC<n>" } });
    expect(read(root, ".gitignore")).toBe(".bearing/traces/\n");
    expect(read(root, ".github/CODEOWNERS")).toContain(
      "/architecture/ @acme\n/.bearing/ @acme\n/.bearing/claims/\n/.github/workflows/ @acme\n",
    );
    expect(read(root, "architecture/workspace.dsl")).toMatch(/^workspace "bearing-init-\w+"/);
  });

  it("writes valid YAML for the config, issue form and workflows", () => {
    const root = emptyRepo();
    init(root);
    for (const path of scaffolded.filter((path) => path.endsWith(".yml") || path.endsWith(".yaml"))) {
      expect(() => parse(read(root, path)), path).not.toThrow();
    }
    expect(parse(read(root, ".github/ISSUE_TEMPLATE/requirement.yml"))).toMatchObject({ labels: ["requirement"] });
    expect(parse(read(root, ".github/workflows/bearing-guard.yml"))).toMatchObject({ on: { pull_request_target: {} } });
    expect(parse(read(root, ".github/workflows/bearing-conformance.yml"))).toMatchObject({
      jobs: { conformance: { name: "bearing/conformance" } },
    });
  });

  it("fills in the integration command and Terraform path when the repo has them", () => {
    const root = emptyRepo();
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "test:integration": "vitest run" } }));
    mkdirSync(join(root, "infra"));
    writeFileSync(join(root, "infra", "main.tf"), "");
    init(root);
    expect(loadConfig(root)).toMatchObject({
      tests: { integration: "npm run test:integration" },
      iac: { terraform: "infra/" },
    });
    expect(read(root, "AGENTS.md")).toContain("`bearing test -- npm run test:integration`");
  });

  it("leaves them commented out when it doesn't", () => {
    const root = emptyRepo();
    init(root);
    const config = loadConfig(root);
    expect(config.tests.integration).toBeUndefined();
    expect(config.iac.terraform).toBeUndefined();
    expect(read(root, ".bearing/config.yaml")).toContain("# integration: npm run test:integration");
  });

  it("appends to AGENTS.md, .gitignore and CODEOWNERS without touching what's there", () => {
    const root = emptyRepo();
    const agents = "# AGENTS.md\n\nRun the linter before pushing.";
    writeFileSync(join(root, "AGENTS.md"), agents);
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github", "CODEOWNERS"), "* @acme/everyone\n/architecture/ @acme/architects\n");
    init(root);
    expect(read(root, "AGENTS.md")).toMatch(new RegExp(`^${agents}\n\n## Bearing\n`));
    expect(read(root, ".gitignore")).toBe("node_modules/\n.bearing/traces/\n");
    const codeowners = read(root, ".github/CODEOWNERS");
    expect(codeowners).toMatch(/^\* @acme\/everyone\n\/architecture\/ @acme\/architects\n\n# Bearing/);
    expect(codeowners).not.toContain("/architecture/ @acme\n");
  });

  it("is safe to re-run and never overwrites edited files", () => {
    const root = emptyRepo();
    init(root);
    const edits: Record<string, string> = {
      ".bearing/config.yaml": `${read(root, ".bearing/config.yaml")}# our own line\n`,
      "AGENTS.md": `${read(root, "AGENTS.md")}- Our own rule.\n`,
      "architecture/workspace.dsl": 'workspace "Shop" {\n  model {\n  }\n}\n',
      ".github/workflows/bearing-guard.yml": "name: edited\n",
    };
    for (const [path, text] of Object.entries(edits)) writeFileSync(join(root, path), text);
    const before = Object.fromEntries(scaffolded.map((path) => [path, read(root, path)]));

    const { actions } = init(root);
    expect(actions.every(({ outcome }) => outcome === "kept")).toBe(true);
    for (const path of scaffolded) expect(read(root, path), path).toBe(before[path]);
  });

  it("uses an existing config's model path, label, tag and self-heal attempts", () => {
    const root = emptyRepo();
    mkdirSync(join(root, ".bearing"));
    writeFileSync(
      join(root, ".bearing", "config.yaml"),
      "version: 1\nmodel: design/model.dsl\nlanguage: typescript\nrequirements:\n  label: story\n" +
        'tests:\n  tag: "REQ-<issue>.<n>"\nagent:\n  selfHealAttempts: 5\n',
    );
    init(root);
    expect(read(root, "design/model.dsl")).toContain("workspace");
    expect(read(root, "design/adrs/.gitkeep")).toBe("");
    expect(parse(read(root, ".github/ISSUE_TEMPLATE/requirement.yml"))).toMatchObject({ labels: ["story"] });
    const agents = read(root, "AGENTS.md");
    expect(agents).toContain("e.g. `REQ-12.2`");
    expect(agents).toContain("After 5 failed attempts, propose a target change in\n  design/model.dsl");
    expect(read(root, ".github/CODEOWNERS")).toContain("/design/ @acme\n");
  });

  it("stops on an invalid existing config", () => {
    const root = emptyRepo();
    mkdirSync(join(root, ".bearing"));
    writeFileSync(join(root, ".bearing", "config.yaml"), "version: 2\n");
    expect(() => init(root)).toThrow(ConfigError);
  });

  it("takes CODEOWNERS owners from --owner, or skips CODEOWNERS without a GitHub remote", () => {
    const withOwners = emptyRepo("");
    init(withOwners, { owners: ["octocat", "@acme/architects"] });
    expect(read(withOwners, ".github/CODEOWNERS")).toContain("/.bearing/ @octocat @acme/architects\n");

    const without = emptyRepo("");
    const { actions } = init(without);
    expect(actions.at(-1)).toMatchObject({ path: ".github/CODEOWNERS", outcome: "skipped" });
  });

  it("prints the repo settings to turn on", () => {
    const root = emptyRepo();
    const output = formatResult(root, init(root, { owners: ["@acme/architects"] }));
    expect(output).toContain("https://github.com/acme/shop/settings/branches");
    expect(output).toContain("require a pull request, with review from Code Owners");
    expect(output).toContain("Required status checks: bearing/target and bearing/conformance");
    expect(output).toContain("gh label create requirement");
  });

  it("lets a sole code owner merge their own PRs", () => {
    const root = emptyRepo();
    const result = init(root);
    expect(result.soleOwner).toBe("@acme");
    const output = formatResult(root, result);
    expect(output).toContain("require a pull request, with no required approvals");
    expect(output).not.toContain("with review from Code Owners.");
    expect(output).toContain("Required status checks: bearing/target and bearing/conformance");
  });

  it.each([
    ["several users", ["@alice", "@bob"]],
    ["a team", ["@acme/architects"]],
  ])("asks for code-owner review when the owners are %s", (_, owners) => {
    const root = emptyRepo();
    expect(init(root, { owners }).soleOwner).toBeUndefined();
  });

  it("reads the owners from CODEOWNERS as it stands on a re-run", () => {
    const root = emptyRepo();
    init(root);
    const owned = (bearing: string) =>
      `/architecture/ @alice\n/.bearing/ ${bearing}\n/.bearing/claims/\n/.github/workflows/ @alice\n`;
    const file = join(root, ".github", "CODEOWNERS");
    writeFileSync(file, owned("@alice"));
    expect(init(root).soleOwner).toBe("@alice");
    writeFileSync(file, owned("@alice @bob"));
    expect(init(root).soleOwner).toBeUndefined();
    // The last matching line wins.
    writeFileSync(file, `${owned("@alice")}/.bearing/ @bob\n`);
    expect(init(root).soleOwner).toBeUndefined();
  });
});
