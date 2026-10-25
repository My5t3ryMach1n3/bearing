import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { Command } from "commander";
import { ConfigError, configPath, parseConfig, type Config } from "./config.js";

// The files `bearing init` writes, laid out as they land in the repo. Shipped next to dist/ in the package.
const templates = new URL("../templates/init/", import.meta.url);

export interface InitOptions {
  // CODEOWNERS owners, e.g. "@octocat" or "@org/team". Defaults to the owner of the GitHub `origin` remote.
  owners?: string[];
}

export interface InitAction {
  path: string;
  outcome: "created" | "kept" | "appended" | "skipped";
  detail?: string;
}

export interface InitResult {
  actions: InitAction[];
  // "owner/repo" when `origin` is on GitHub.
  repo?: string;
  // The issue label the requirement form applies.
  label: string;
}

// Scaffolds Bearing into the repo at `root`. Never overwrites a file that exists: whole files are only
// written when missing, and AGENTS.md, .gitignore and CODEOWNERS are only appended to, when Bearing's part is missing.
export function init(dir: string, options: InitOptions = {}): InitResult {
  const root = resolve(dir);
  const actions: InitAction[] = [];
  const repo = githubRepo(root);

  const configFile = join(root, configPath);
  let configText: string;
  if (existsSync(configFile)) {
    configText = readFileSync(configFile, "utf8");
    actions.push({ path: configPath, outcome: "kept" });
  } else {
    configText = render(".bearing/config.yaml", detectConfig(root));
    actions.push(create(root, configPath, configText));
  }
  const config = parseConfig(configText, root, configPath);

  const model = config.model;
  actions.push(
    model.endsWith(".dsl")
      ? createIfMissing(root, model, () => render("architecture/workspace.dsl", { name: basename(root) }))
      : { path: model, outcome: "skipped", detail: "not a .dsl file" },
  );
  actions.push(keepDir(root, posix.join(posix.dirname(model), "adrs")));
  actions.push(keepDir(root, ".bearing/claims"));
  const tagExample = config.tests.tag.replace("<issue>", "12").replace("<n>", "2");
  const issueForm = ".github/ISSUE_TEMPLATE/requirement.yml";
  actions.push(
    createIfMissing(root, issueForm, () => render(issueForm, { label: config.requirements.label, tagExample })),
  );
  for (const workflow of [".github/workflows/bearing-guard.yml", ".github/workflows/bearing-conformance.yml"]) {
    actions.push(createIfMissing(root, workflow, () => template(workflow)));
  }

  actions.push(gitignore(root));
  actions.push(agentsSection(root, config, tagExample));
  const owners = (options.owners ?? (repo ? [`@${repo.split("/")[0]}`] : [])).map((owner) =>
    owner.startsWith("@") || owner.includes("@") ? owner : `@${owner}`,
  );
  actions.push(codeowners(root, posix.dirname(model), owners));

  return { actions, repo, label: config.requirements.label };
}

function template(path: string): string {
  return readFileSync(new URL(path, templates), "utf8");
}

// Fills `{{name}}` placeholders. Workflows' `${{ ... }}` expressions have spaces, so they never match.
function render(path: string, vars: Record<string, string>): string {
  return template(path).replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`template ${path} needs {{${key}}}`);
    return value;
  });
}

// Uncomments the optional config keys this repo looks like it needs.
function detectConfig(root: string): Record<string, string> {
  let scripts: Record<string, unknown> = {};
  try {
    scripts =
      (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: typeof scripts }).scripts ?? {};
  } catch {
    // No package.json, or not JSON: leave the test command for the team to fill in.
  }
  const integration = "integration: npm run test:integration";
  const terraform = ["infra", "terraform"].find((dir) => {
    try {
      return readdirSync(join(root, dir)).some((file) => file.endsWith(".tf"));
    } catch {
      return false;
    }
  });
  return {
    integration: "test:integration" in scripts ? integration : `# ${integration}`,
    iac: terraform ? `iac:\n  terraform: ${terraform}/` : "# iac:\n#   terraform: infra/",
  };
}

function create(root: string, path: string, text: string): InitAction {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return { path, outcome: "created" };
}

function createIfMissing(root: string, path: string, text: () => string): InitAction {
  return existsSync(join(root, path)) ? { path, outcome: "kept" } : create(root, path, text());
}

// Creates an empty directory with a .gitkeep so git tracks it; leaves an existing directory alone.
function keepDir(root: string, path: string): InitAction {
  return existsSync(join(root, path)) ? { path: `${path}/`, outcome: "kept" } : create(root, `${path}/.gitkeep`, "");
}

// Appends `text` to a file on a line of its own, after a blank line if `paragraph`, creating the file if needed.
function append(root: string, path: string, text: string, detail: string, paragraph = true): InitAction {
  const file = join(root, path);
  if (!existsSync(file)) return { ...create(root, path, text), detail };
  const existing = readFileSync(file, "utf8");
  const newline = existing === "" || existing.endsWith("\n") ? "" : "\n";
  const blank = paragraph && existing !== "" && !existing.endsWith("\n\n") ? "\n" : "";
  appendFileSync(file, newline + blank + text);
  return { path, outcome: "appended", detail };
}

function gitignore(root: string): InitAction {
  const path = ".gitignore";
  const file = join(root, path);
  const lines = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
    : [];
  if (lines.some((line) => /^\/?\.bearing\/(traces\/?)?$/.test(line))) return { path, outcome: "kept" };
  return append(root, path, ".bearing/traces/\n", ".bearing/traces/", false);
}

function agentsSection(root: string, config: Config, tagExample: string): InitAction {
  const path = "AGENTS.md";
  const file = join(root, path);
  if (existsSync(file) && /^#{1,6}\s+Bearing\s*$/m.test(readFileSync(file, "utf8"))) return { path, outcome: "kept" };
  const section = render("AGENTS.md", {
    model: config.model,
    tagExample,
    integration: config.tests.integration ?? "<your integration test command>",
    attempts: String(config.agent.selfHealAttempts),
  });
  return append(root, path, section, "the Bearing section");
}

// GitHub reads CODEOWNERS from the first of these that exists.
const codeownersPaths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

function codeowners(root: string, modelDir: string, owners: string[]): InitAction {
  const path = codeownersPaths.find((candidate) => existsSync(join(root, candidate))) ?? codeownersPaths[0]!;
  if (owners.length === 0) {
    return { path, outcome: "skipped", detail: "no GitHub `origin` remote to take an owner from; pass --owner" };
  }
  const owned = owners.join(" ");
  // The last matching line wins, so claims, which every governed PR writes, are left without an owner.
  const entries: Array<[string, string]> = [
    [`/${modelDir}/`, owned],
    ["/.bearing/", owned],
    ["/.bearing/claims/", ""],
    ["/.github/workflows/", owned],
  ];
  const file = join(root, path);
  const patterns = new Set(
    (existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").map((line) => line.trim().split(/\s+/)[0]),
  );
  const missing = entries.filter(([pattern]) => !patterns.has(pattern));
  if (missing.length === 0) return { path, outcome: "kept" };
  const lines = missing.map(([pattern, who]) => (who ? `${pattern} ${who}` : pattern));
  const text = `# Bearing: changes to the target, its config or the workflows need code-owner approval.\n${lines.join("\n")}\n`;
  return append(root, path, text, `${missing.length} entries for ${owned}`);
}

// "owner/repo" from a github.com `origin` remote, if there is one.
function githubRepo(root: string): string | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: "pipe" });
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
  } catch {
    return undefined;
  }
}

export function formatResult(root: string, result: InitResult): string {
  const width = Math.max(...result.actions.map((action) => action.outcome.length));
  const lines = [`Set up Bearing in ${root}:`];
  for (const { path, outcome, detail } of result.actions) {
    lines.push(`  ${outcome.padEnd(width)}  ${path}${detail ? ` (${detail})` : ""}`);
  }
  const settings = result.repo ? ` at https://github.com/${result.repo}/settings/branches` : "";
  lines.push(
    "",
    `Once this is merged to main, turn on these repo settings${settings}:`,
    "  - [ ] Branch protection on main: require a pull request, with review from Code Owners.",
    "  - [ ] Required status checks: bearing/target and bearing/conformance. GitHub only lists them once the",
    "        workflows have run on a pull request.",
    "  - [ ] Optional, on organisation plans with rulesets: make the conformance workflow a required workflow",
    "        sourced from main.",
    "",
    "The requirement issue form needs its label to exist:",
    `  gh label create ${result.label} --description "A user story Bearing designs and checks against"`,
  );
  return `${lines.join("\n")}\n`;
}

export function initCommand(): Command {
  return new Command("init")
    .description("scaffold Bearing into a repo: model, config, issue form, workflows, CODEOWNERS and AGENTS.md")
    .argument("[dir]", "the repo root", ".")
    .option(
      "--owner <owners...>",
      "CODEOWNERS owners for the model, config and workflows (default: the origin remote's owner)",
    )
    .action(function (this: Command, dir: string, options: { owner?: string[] }) {
      const root = resolve(dir);
      if (!existsSync(root)) this.error(`error: ${dir} not found`);
      try {
        process.stdout.write(formatResult(root, init(root, { owners: options.owner })));
      } catch (error) {
        if (error instanceof ConfigError) this.error(`error: ${error.message}`);
        throw error;
      }
    });
}
