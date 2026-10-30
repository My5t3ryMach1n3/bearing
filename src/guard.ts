import { Command } from "commander";
import { claimsDir, modelPathspec } from "./claims.js";
import { ConfigError, configPath, parseConfig } from "./config.js";
import { GitHubError, githubApi, githubRepository, githubToken, type GitHubCall } from "./github.js";
import { guardEnd, guardLimit, guardStart, pullRequestNumber, writeComment } from "./report.js";

// `bearing guard`: the job that flags a target change. It runs on `pull_request_target`, from the base branch, and
// reads the PR through the GitHub API only: it never checks out or runs the PR's code, so a PR can't switch it off.
// A PR that changes the model's folder, .bearing/ (except claims) or .github/workflows/ gets the
// `architecture-change` label, the changed files' diffs at the top of Bearing's comment, and a `bearing/target`
// status that says so. The guard reports; the status is always a success, so it never blocks a merge on its own. See
// the GitHub Action section of docs/product-spec.md.

export const targetLabel = "architecture-change";
export const targetContext = "bearing/target";

// The account Actions' token comments as. The guard only edits a comment it wrote.
export const actionsBot = "github-actions[bot]";

// A file in the PR, as GitHub's "list pull request files" endpoint returns it.
export interface PullFile {
  filename: string;
  status: string;
  previous_filename?: string;
  // The unified diff, absent for binary files and very large diffs.
  patch?: string;
}

export interface GuardResult {
  pr: number;
  head: string;
  // The files that make the PR a target change. Empty when it isn't one.
  targetFiles: PullFile[];
  description: string;
  commentUrl?: string;
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

// The paths whose changes are a target change, for a model at `model`: its folder, Bearing's config and the
// workflows. Claims files are in .bearing/ too, but a claim describes a change rather than making one.
export function isTargetPath(path: string, model: string): boolean {
  const under = (dir: string) => path === dir || path.startsWith(`${dir}/`);
  const modelDir = modelPathspec({ model });
  return (
    under(modelDir) || (under(".bearing") && !under(claimsDir.replaceAll("\\", "/"))) || under(".github/workflows")
  );
}

// A file renamed into or out of a target path counts too.
export function targetFiles(files: PullFile[], model: string): PullFile[] {
  return files.filter(
    (file) =>
      isTargetPath(file.filename, model) ||
      (file.previous_filename !== undefined && isTargetPath(file.previous_filename, model)),
  );
}

// The guard's section of Bearing's comment: each target file's diff, up to `guardLimit` characters. Undefined when
// the PR doesn't change the target. It always comes first in the comment: the report under it is written by the PR's
// own run, so anything put below that could be swallowed by an unclosed fence or HTML comment. The diffs are folded so
// the report's diagrams are what a reviewer meets next.
export function formatGuard(files: PullFile[], base: string): string | undefined {
  if (files.length === 0) return undefined;
  const head = [
    guardStart,
    "### ⚠️ Target change: the authoritative diff",
    "",
    `This PR changes the target, Bearing's config or its workflows, so merging it approves the change. Bearing's guard lists these diffs from \`${base}\`, so the PR can't hide them. Everything below this section comes from the PR's own run, so if it disagrees with these diffs, believe the diffs.`,
  ].join("\n");
  const sections: string[] = [];
  let length = head.length + guardEnd.length;
  const left: string[] = [];
  for (const file of files) {
    const name =
      file.previous_filename === undefined || file.previous_filename === file.filename
        ? `<code>${html(file.filename)}</code>`
        : `<code>${html(file.previous_filename)}</code> → <code>${html(file.filename)}</code>`;
    const summary = `<details><summary>${name} (${file.status})</summary>`;
    // The PR writes the patch, so it can't close the fence or the guard's section early.
    const patch = file.patch?.replaceAll(guardEnd, guardEnd.replace("guard", "guard​"));
    const fence = "`".repeat(Math.max(3, ...[...(patch ?? "").matchAll(/`+/g)].map((run) => run[0].length + 1)));
    const body =
      patch === undefined
        ? "GitHub gives no diff for this file; see the PR's Files changed tab."
        : `${fence}diff\n${patch}\n${fence}`;
    const section = `${summary}\n\n${body}\n\n</details>`;
    if (length + section.length > guardLimit) {
      left.push(`\`${file.filename.replaceAll("`", "")}\``);
      continue;
    }
    sections.push(section);
    length += section.length + 2;
  }
  if (left.length > 0) {
    sections.push(`Too long for the comment; see the PR's Files changed tab for ${left.join(", ")}.`);
  }
  return [head, ...sections, guardEnd].join("\n\n");
}

function html(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface GuardOptions {
  repository: string;
  pr: number;
  token: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

// Looks at the PR through the API and labels it, comments and sets `bearing/target`.
export async function guard(options: GuardOptions): Promise<GuardResult> {
  const { repository, pr, env = process.env, fetch: fetchFn = fetch, log = () => {} } = options;
  const call = githubApi(options.token, env, fetchFn);
  const pull = (await call("GET", `/repos/${repository}/pulls/${pr}`)) as {
    head: { sha: string };
    base: { sha: string; ref: string };
  };
  const model = await baseModel(call, repository, pull.base.sha, log);

  const files: PullFile[] = [];
  for (let page = 1; ; page++) {
    const batch = (await call("GET", `/repos/${repository}/pulls/${pr}/files?per_page=100&page=${page}`)) as PullFile[];
    files.push(...batch);
    if (batch.length < 100) break;
  }
  const changed = targetFiles(files, model);

  if (changed.length > 0) {
    await call("POST", `/repos/${repository}/issues/${pr}/labels`, { labels: [targetLabel] });
  } else {
    try {
      await call("DELETE", `/repos/${repository}/issues/${pr}/labels/${targetLabel}`);
    } catch (error) {
      // 404: the PR doesn't have the label.
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
  }

  const section = formatGuard(changed, pull.base.ref);
  const comment = await writeComment(
    (existing) => {
      const parts = { ...existing };
      if (section === undefined) delete parts.guard;
      else parts.guard = section;
      return parts;
    },
    { repository, pr, token: options.token, env, fetch: fetchFn, author: actionsBot },
  );

  const count = changed.length === 1 ? "1 file" : `${changed.length} files`;
  const description =
    changed.length > 0 ? `Target change in ${count}: merging approves it. Read its diff first` : "Target unchanged";
  await call("POST", `/repos/${repository}/statuses/${pull.head.sha}`, {
    state: "success",
    context: targetContext,
    description,
    ...(changed.length > 0 && comment.url !== undefined ? { target_url: comment.url } : {}),
  });

  return {
    pr,
    head: pull.head.sha,
    targetFiles: changed,
    description,
    ...(comment.url === undefined ? {} : { commentUrl: comment.url }),
  };
}

// The model's path in the base branch's config. The base's, not the PR's, so a PR can't move the model out from under
// the guard. Falls back to the default model when the base has no readable config, so the status is still set.
async function baseModel(
  call: GitHubCall,
  repository: string,
  sha: string,
  log: (message: string) => void,
): Promise<string> {
  const fallback = "architecture/workspace.dsl";
  const path = configPath.replaceAll("\\", "/");
  try {
    const file = (await call("GET", `/repos/${repository}/contents/${path}?ref=${sha}`)) as { content: string };
    return parseConfig(Buffer.from(file.content, "base64").toString("utf8"), ".", path).model;
  } catch (error) {
    if (error instanceof ConfigError || (error instanceof GitHubError && error.status === 404)) {
      log(`warning: can't read ${path} on the base branch, so taking the model to be ${fallback}: ${error.message}`);
      return fallback;
    }
    throw error;
  }
}

export function guardCommand(): Command {
  return new Command("guard")
    .description(
      `flag a target change: for a PR that changes the model, .bearing/ (except claims) or the workflows, label it ${targetLabel}, put the changed files' diffs at the top of Bearing's comment, and say so in the ${targetContext} status. Reads the PR through the GitHub API only, for the guard workflow's pull_request_target job`,
    )
    .option("--pr <number>", "the pull request to guard; defaults, in GitHub Actions, to the event's")
    .action(async function (this: Command, options: { pr?: string }) {
      if (options.pr !== undefined && !/^[1-9]\d*$/.test(options.pr)) {
        this.error(`error: "${options.pr}" is not a pull request number`);
      }
      try {
        const pr = options.pr === undefined ? await pullRequestNumber() : Number(options.pr);
        if (pr === undefined) throw new GuardError("can't tell which pull request to guard; pass --pr");
        const repository = await githubRepository(process.cwd(), process.env);
        if (repository === undefined) {
          throw new GuardError(
            "can't tell which GitHub repository to guard; set GITHUB_REPOSITORY=owner/name, or add a GitHub origin remote",
          );
        }
        const token = await githubToken(process.env);
        if (token === undefined) {
          throw new GuardError(
            "no GitHub token to call the API with; set GITHUB_TOKEN, or install the GitHub CLI and run `gh auth login`",
          );
        }
        const result = await guard({
          repository,
          pr,
          token,
          log: (message) => process.stderr.write(`${message}\n`),
        });
        const lines = [`#${result.pr} at ${result.head.slice(0, 7)}: ${result.description}`];
        for (const file of result.targetFiles) lines.push(`  ${file.status.padEnd(8)}  ${file.filename}`);
        if (result.commentUrl !== undefined && result.targetFiles.length > 0) lines.push(result.commentUrl);
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (error) {
        if (error instanceof GuardError || error instanceof GitHubError) this.error(`error: ${error.message}`);
        throw error;
      }
    });
}
