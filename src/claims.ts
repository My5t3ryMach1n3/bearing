import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { Ajv, type JSONSchemaType } from "ajv";
import { Command } from "commander";
import { Document, isSeq, parseDocument } from "yaml";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { diffModels, loadModel } from "./diff.js";
import type { Model } from "./model.js";
import { componentOf, componentPaths, declarationFile, testFile } from "./paths.js";
import { StructurizrError } from "./structurizr.js";

// The claims file: the agent's statement of what its branch built, at `.bearing/claims/<branch>.yaml` and kept
// after merge. The Claim check tests it against the as-built model. See the Claims file section of
// docs/product-spec.md.

export interface Claim {
  branch: string;
  // The requirements the branch works on, e.g. ["#2"].
  issues: string[];
  // Stable IDs of the elements and relationships the branch adds to or removes from the model, e.g. "basketService"
  // or "basketController->basketService".
  model: { added: string[]; removed: string[] };
  // The changed source files, each with the component that owns it. A file under no component path has none.
  files: Array<{ path: string; component?: string }>;
  note: string;
}

export const claimsDir = join(".bearing", "claims");

const claimSchema: JSONSchemaType<Claim> = {
  type: "object",
  additionalProperties: false,
  required: ["branch", "issues", "model", "files", "note"],
  properties: {
    branch: { type: "string", minLength: 1 },
    issues: { type: "array", items: { type: "string", pattern: "^#[1-9][0-9]*$" } },
    model: {
      type: "object",
      additionalProperties: false,
      required: ["added", "removed"],
      properties: {
        added: { type: "array", items: { type: "string", minLength: 1 } },
        removed: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1 },
          component: { type: "string", minLength: 1, nullable: true },
        },
      },
    },
    note: { type: "string" },
  },
};

const validate = new Ajv({ allErrors: true }).compile(claimSchema);

export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimError";
  }
}

// The claims file for a branch, relative to the repo root. Characters outside [A-Za-z0-9._-], the slash above all,
// are percent-encoded, so every branch gets its own file name on every filesystem: `feat/issue-2` is
// `feat%2Fissue-2.yaml`.
export function claimFile(branch: string): string {
  const name = branch.replace(/[^A-Za-z0-9._-]/g, (char) =>
    [...Buffer.from(char)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
  return join(claimsDir, `${name}.yaml`);
}

// Parses and validates a claims file's text. `file` only labels error messages.
export function parseClaim(text: string, file: string): Claim {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0) throw new ClaimError(`${file}: ${doc.errors[0]!.message.split("\n")[0]}`);
  const data: unknown = doc.toJS();
  if (!validate(data)) {
    const problems = (validate.errors ?? []).map((error) => {
      const at = error.instancePath.split("/").slice(1).join(".") || "(root)";
      if (error.keyword === "additionalProperties")
        return `"${at}" has unknown key "${error.params.additionalProperty}"`;
      if (error.keyword === "pattern") return `"${at}" must be an issue like "#2"`;
      return `"${at}" ${error.message ?? "is invalid"}`;
    });
    throw new ClaimError(`${file}:\n${[...new Set(problems)].map((problem) => `  - ${problem}`).join("\n")}`);
  }
  return data;
}

// Reads a branch's claims file, or undefined if it has none.
export async function readClaim(config: Config, branch: string): Promise<Claim | undefined> {
  const file = claimFile(branch);
  const path = join(config.root, file);
  if (!existsSync(path)) return undefined;
  return parseClaim(await readFile(path, "utf8"), file);
}

// Claims files in the fixtures' style: flow lists for issues and model changes, a block list for files.
export function formatClaim(claim: Claim): string {
  const doc = new Document(claim);
  for (const path of [["issues"], ["model", "added"], ["model", "removed"]]) {
    const node = doc.getIn(path, true);
    if (isSeq(node)) node.flow = true;
  }
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

export interface DraftOptions {
  branch: string;
  // The commit the branch forked from, e.g. the merge base with main.
  base: string;
  // The branch's claims file as the agent last confirmed it, whose issues and note are kept.
  previous?: Claim;
}

// Drafts a branch's claim from its diff against the base, for the agent to confirm: the elements and relationships
// its target adds or removes, and its changed source files with the components the target gives them. Committed,
// staged, unstaged and untracked changes all count, so the draft can be made before committing.
//
// The model changes come from the target alone, never from the code: drafting them from the as-built model would
// make every claim agree with it, and the Claim check is there to catch an agent that misreads its own change. If
// the code makes a relationship the target doesn't declare, the agent has to add it to the claim itself.
//
// Issues come from the branch name, `issue-2-add-item` or `2-add-item`, and from the requirements of what the
// target adds, unless the previous claim already names them.
export async function draftClaim(config: Config, options: DraftOptions): Promise<Claim> {
  const { branch, base, previous } = options;
  const target = await loadModel(join(config.root, config.model), () => config);
  const added: string[] = [];
  const removed: string[] = [];
  const requirements = new Set<string>();
  const modelDir = posix.dirname(toPosix(config.model));
  if (await changedSince(config.root, base, modelDir)) {
    const diff = diffModels(await targetAt(config, base), target);
    for (const item of [...diff.elements.added, ...diff.relationships.added]) {
      added.push(item.id);
      for (const issue of item.requirements) requirements.add(issue);
    }
    removed.push(...[...diff.elements.removed, ...diff.relationships.removed].map((item) => item.id));
  }

  const components = componentPaths(target);
  const files = (await changedFiles(config.root, base))
    .filter((path) => sourceFile.test(path) && !testFile.test(path) && !declarationFile.test(path))
    .map((path) => {
      const component = componentOf(path, components);
      return component === undefined ? { path } : { path, component };
    });

  for (const issue of issuesInBranch(branch)) requirements.add(issue);
  const byNumber = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));
  return {
    branch,
    issues: previous?.issues.length ? previous.issues : [...requirements].sort(byNumber),
    model: { added: added.sort(), removed: removed.sort() },
    files,
    note: previous?.note ?? "",
  };
}

// The source files a language adapter reads. TypeScript only for now.
const sourceFile = /\.[cm]?[jt]sx?$/;

// `issue-2-add-item`, `issues/2`, `2-add-item` and `feat/2-add-item` all work on #2.
export function issuesInBranch(branch: string): string[] {
  const issues = branch
    .split("/")
    .map((segment) => /^(?:issues?[-_]?)?([1-9][0-9]*)(?:[-_]|$)/i.exec(segment)?.[1])
    .filter((issue) => issue !== undefined);
  return [...new Set(issues)].map((issue) => `#${issue}`);
}

// The target as it stood at a commit: its model folder from that commit, loaded in a temp directory.
async function targetAt(config: Config, commit: string): Promise<Model> {
  const root = await mkdtemp(join(tmpdir(), "bearing-claim-"));
  try {
    const modelDir = posix.dirname(toPosix(config.model));
    const files = (
      await git(config.root, ["ls-tree", "-r", "-z", "--name-only", "--full-name", commit, "--", modelDir])
    )
      .split("\0")
      .filter((file) => file !== "");
    if (files.length === 0) throw new ClaimError(`${config.model} not found at ${commit.slice(0, 12)}`);
    const prefix = (await git(config.root, ["rev-parse", "--show-prefix"])).trim();
    for (const file of files) {
      const path = join(root, relative(prefix, file));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await git(config.root, ["show", `${commit}:${file}`], "buffer"));
    }
    return await loadModel(join(root, config.model), () => ({ ...config, root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function changedSince(root: string, commit: string, path: string): Promise<boolean> {
  const tracked = await git(root, ["diff", "--name-only", "-z", commit, "--", path]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
  return tracked !== "" || untracked !== "";
}

// Files added or modified since a commit, relative to the repo root and sorted. Deleted files are left out.
async function changedFiles(root: string, commit: string): Promise<string[]> {
  const split = (output: string) => output.split("\0").filter((file) => file !== "");
  const tracked = split(
    await git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=d", "--relative", "-z", commit]),
  );
  const untracked = split(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

// The branch HEAD is on; in a GitHub Actions pull request, which checks out a detached merge commit, the PR's
// head branch.
export async function currentBranch(root: string): Promise<string> {
  try {
    return (await git(root, ["symbolic-ref", "--short", "HEAD"])).trim();
  } catch {
    const head = process.env.GITHUB_HEAD_REF;
    if (head) return head;
    throw new ClaimError("HEAD is not on a branch; pass --branch");
  }
}

// The commit the branch forked from: its merge base with `base`, or by default with the remote's default branch,
// falling back to main.
export async function forkPoint(root: string, base?: string): Promise<string> {
  let ref = base;
  if (ref === undefined) {
    try {
      ref = (await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    } catch {
      ref = "main";
    }
  }
  try {
    return (await git(root, ["merge-base", ref, "HEAD"])).trim();
  } catch {
    throw new ClaimError(`can't find where this branch forked from ${ref}; pass --base`);
  }
}

function git(root: string, args: string[]): Promise<string>;
function git(root: string, args: string[], encoding: "buffer"): Promise<Buffer>;
function git(root: string, args: string[], encoding?: "buffer"): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { encoding: encoding ?? "utf8", maxBuffer: 256 * 1024 * 1024 },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    );
  });
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

export function claimCommand(): Command {
  return new Command("claim")
    .description(
      "draft this branch's claims file, .bearing/claims/<branch>.yaml, from its diff: the issues it works on, what it adds to or removes from the target, and the components of the files it changes. Check it, fill in the note, and commit it",
    )
    .option("--branch <name>", "the branch to claim for; defaults to the current one")
    .option("--base <ref>", "the branch this one forked from; defaults to the remote's default branch, then main")
    .action(async function (this: Command, options: { branch?: string; base?: string }) {
      try {
        const config = loadConfig();
        const branch = options.branch ?? (await currentBranch(config.root));
        const base = await forkPoint(config.root, options.base);
        const file = claimFile(branch);
        const previous = await readClaim(config, branch);
        const claim = await draftClaim(config, { branch, base, previous });
        const text = formatClaim(claim);
        await mkdir(join(config.root, claimsDir), { recursive: true });
        await writeFile(join(config.root, file), text);
        const todo = [
          ...(claim.issues.length === 0 ? ["list the issues this branch works on under issues"] : []),
          ...(claim.note === "" ? ["say what the branch does in the note"] : []),
          "add any relationship the code makes that the target doesn't declare to model.added",
        ];
        process.stdout.write(
          `${previous === undefined ? "Drafted" : "Redrafted"} ${toPosix(file)}:\n\n${text}\n` +
            `Check it before committing it: ${todo.join("; ")}.\n`,
        );
      } catch (error) {
        if (error instanceof ConfigError || error instanceof StructurizrError || error instanceof ClaimError) {
          this.error(`error: ${error.message}`);
        }
        throw error;
      }
    });
}
