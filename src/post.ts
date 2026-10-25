import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import type { CheckReport } from "./check.js";
import { GitHubError, githubApi, githubRepository, githubToken } from "./github.js";
import { actionsBot } from "./guard.js";
import { guardEnd, guardLimit, guardStart, postComment, reportMarker } from "./report.js";

// `bearing post`: the report job, which puts the conformance job's results on the PR. The conformance job runs the
// PR's code on `pull_request`, where a fork's PR gets no token that can write, so it uploads what it wrote and this
// runs on `workflow_run`, from the default branch, to post it. The PR's code wrote every file it reads, so they're
// untrusted: the PR number is only believed when that PR's head is the commit the conformance run checked, the comment
// can't take over the guard's section, and `bearing/advisory` is always a success. See the GitHub Action section of
// docs/product-spec.md.

export const advisoryContext = "bearing/advisory";

// What the conformance job uploads, as files in one directory.
export const uploads = { pr: "pr", comment: "comment.md", check: "check.json" };

// GitHub rejects a longer status description.
const descriptionLimit = 140;
// The report's share of a comment, as `formatComment` keeps to.
const reportLimit = 65_536 - guardLimit;

export interface PostResult {
  pr: number;
  head: string;
  // Why nothing was posted, when it wasn't.
  skipped?: string;
  commentUrl?: string;
  advisory?: string;
}

export class PostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostError";
  }
}

export interface PostOptions {
  // The directory the conformance job's upload was downloaded to.
  dir: string;
  repository: string;
  // The commit the conformance run checked.
  head: string;
  token: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export async function post(options: PostOptions): Promise<PostResult> {
  const { dir, repository, head, env = process.env, fetch: fetchFn = fetch } = options;
  const text = await readUpload(dir, uploads.pr);
  const number = text?.trim();
  if (number === undefined || !/^[1-9]\d{0,9}$/.test(number)) {
    throw new PostError(`${join(dir, uploads.pr)} doesn't hold a pull request number`);
  }
  const pr = Number(number);
  const call = githubApi(options.token, env, fetchFn);
  const pull = (await call("GET", `/repos/${repository}/pulls/${pr}`)) as { head: { sha: string } };
  // Either the upload names another PR, or the PR has moved on and a newer run will post for it.
  if (pull.head.sha !== head) {
    return { pr, head, skipped: `#${pr} is at ${pull.head.sha.slice(0, 7)}, not the ${head.slice(0, 7)} checked` };
  }

  const result: PostResult = { pr, head };
  const comment = await readUpload(dir, uploads.comment);
  if (comment !== undefined && comment.trim() !== "") {
    const posted = await postComment(reportBody(comment), {
      repository,
      pr,
      token: options.token,
      env,
      fetch: fetchFn,
      author: actionsBot,
    });
    result.commentUrl = posted.url;
  }

  const advisory = advisoryDescription(await readUpload(dir, uploads.check));
  await call("POST", `/repos/${repository}/statuses/${head}`, {
    state: "success",
    context: advisoryContext,
    description: advisory,
    ...(result.commentUrl === undefined ? {} : { target_url: result.commentUrl }),
  });
  result.advisory = advisory;
  return result;
}

async function readUpload(dir: string, name: string): Promise<string | undefined> {
  const path = join(dir, name);
  return existsSync(path) ? readFile(path, "utf8") : undefined;
}

// The report part of Bearing's comment, from what the conformance job wrote. Its guard markers are broken, so it can't
// pass for or close the guard's section, and it's cut to the report's share of the comment.
export function reportBody(comment: string): string {
  const body = comment
    .replaceAll(guardStart, guardStart.replace("guard", "guard​"))
    .replaceAll(guardEnd, guardEnd.replace("guard", "guard​"));
  const marked = body.startsWith(reportMarker) ? body : `${reportMarker}\n\n${body}`;
  return marked.length <= reportLimit
    ? marked
    : `${marked.slice(0, reportLimit - 100)}\n\n…cut: too long for a comment.\n`;
}

// What `bearing/advisory` says: the advisory checks' results, read from `bearing check --json`.
export function advisoryDescription(text: string | undefined): string {
  let report: Partial<CheckReport> | undefined;
  try {
    report = text === undefined ? undefined : (JSON.parse(text) as Partial<CheckReport>);
  } catch {
    // Not JSON: `bearing check` stopped with an error.
  }
  const checks = Array.isArray(report?.checks) ? report.checks : undefined;
  if (checks === undefined) return "No check results: see the conformance job";
  const surplus = checks.find((check) => check?.check === "surplus");
  if (surplus === undefined || surplus.status === "skipped") return "Surplus skipped";
  if (surplus.status === "passed") return "Surplus: nothing flagged";
  const outside = Array.isArray(surplus.outside) ? surplus.outside.length : 0;
  const untraced = Array.isArray(surplus.untraced)
    ? surplus.untraced.reduce((sum, file) => sum + (Array.isArray(file?.functions) ? file.functions.length : 0), 0)
    : 0;
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const found = [
    ...(outside > 0 ? [`${count(outside, "file")} outside every component`] : []),
    ...(untraced > 0 ? [`${count(untraced, "exported function")} no tagged test calls`] : []),
  ];
  const description = `Surplus flagged${found.length > 0 ? `: ${found.join(", ")}` : ""}. Advisory only`;
  return description.slice(0, descriptionLimit);
}

// The commit a `workflow_run` event's run checked.
async function eventHead(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  try {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as {
      workflow_run?: { head_sha?: string };
    };
    return event.workflow_run?.head_sha;
  } catch {
    return undefined;
  }
}

export function postCommand(): Command {
  return new Command("post")
    .description(
      `post the conformance job's results from the report workflow's workflow_run job: update Bearing's comment with the comment it wrote, keeping the guard's section, and set ${advisoryContext}. Only posts when the PR it names is still at the commit that was checked`,
    )
    .argument("<dir>", "the directory the conformance job's upload was downloaded to")
    .option(
      "--head <sha>",
      "the commit the conformance run checked; defaults, in GitHub Actions, to the workflow_run's",
    )
    .action(async function (this: Command, dir: string, options: { head?: string }) {
      try {
        const head = options.head ?? (await eventHead(process.env));
        if (head === undefined || !/^[0-9a-f]{7,64}$/.test(head)) {
          throw new PostError("can't tell which commit the conformance run checked; pass --head");
        }
        const repository = await githubRepository(process.cwd(), process.env);
        if (repository === undefined) {
          throw new PostError(
            "can't tell which GitHub repository to post on; set GITHUB_REPOSITORY=owner/name, or add a GitHub origin remote",
          );
        }
        const token = await githubToken(process.env);
        if (token === undefined) {
          throw new PostError(
            "no GitHub token to post with; set GITHUB_TOKEN, or install the GitHub CLI and run `gh auth login`",
          );
        }
        const result = await post({ dir, repository, head, token });
        const lines =
          result.skipped === undefined
            ? [
                `#${result.pr} at ${head.slice(0, 7)}: ${result.advisory}`,
                ...(result.commentUrl ? [result.commentUrl] : []),
              ]
            : [`Nothing posted: ${result.skipped}`];
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (error) {
        if (error instanceof PostError || error instanceof GitHubError) this.error(`error: ${error.message}`);
        throw error;
      }
    });
}
