import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import type { CheckReport } from "./check.js";
import { GitHubError, githubApi, githubRepository, githubToken, type GitHubCall } from "./github.js";
import { actionsBot, changesWorkflows, pullFiles } from "./guard.js";
import { guardEnd, guardLimit, guardStart, postComment, reportMarker } from "./report.js";

// `bearing post`: the report job, which puts the conformance job's results on the PR. The conformance job runs the
// PR's code on `pull_request`, where a fork's PR gets no token that can write, so it uploads what it wrote and this
// runs on `workflow_run`, from the default branch, to post it. The PR's code wrote every file it reads, so they're
// untrusted: the PR number is only believed when that PR's head is the commit the conformance run checked, the comment
// can't take over the guard's section, and `bearing/advisory` is always a success. The architecture page the run
// uploaded is linked only for a PR from this repo that leaves the workflows alone, which it checks from the PR's files
// through the API, as the guard does. See the GitHub Action section of docs/product-spec.md.

export const advisoryContext = "bearing/advisory";

// What the conformance job uploads, as files in one directory.
export const uploads = { pr: "pr", comment: "comment.md", check: "check.json" };

// The architecture page, which the conformance job uploads unzipped, so the artifact takes the file's name.
export const pageArtifact = "bearing-architecture.html";

// What the comment says instead of linking the page for a PR that changes the workflows.
export const pageLeftOut =
  "🧭 No architecture page: this PR changes the workflows, so the page would come from the very workflow it changes. The guard's diffs above are the authoritative view.";

// The most files GitHub lists for a PR.
const filesListed = 3000;
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
  // The architecture page the comment links, when it links one.
  pageUrl?: string;
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
  // The conformance run, whose artifacts hold the architecture page. No page is linked without it.
  run?: number;
  token: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export async function post(options: PostOptions): Promise<PostResult> {
  const { dir, repository, head, env = process.env, fetch: fetchFn = fetch, log = () => {} } = options;
  const text = await readUpload(dir, uploads.pr);
  const number = text?.trim();
  if (number === undefined || !/^[1-9]\d{0,9}$/.test(number)) {
    throw new PostError(`${join(dir, uploads.pr)} doesn't hold a pull request number`);
  }
  const pr = Number(number);
  const call = githubApi(options.token, env, fetchFn);
  const pull = (await call("GET", `/repos/${repository}/pulls/${pr}`)) as PullHead;
  // Either the upload names another PR, or the PR has moved on and a newer run will post for it.
  if (pull.head.sha !== head) {
    return { pr, head, skipped: `#${pr} is at ${pull.head.sha.slice(0, 7)}, not the ${head.slice(0, 7)} checked` };
  }

  const result: PostResult = { pr, head };
  const comment = await readUpload(dir, uploads.comment);
  if (comment !== undefined && comment.trim() !== "") {
    const page = await pageLink({ call, repository, pr, pull, run: options.run, env, log });
    if (page.url !== undefined) result.pageUrl = page.url;
    const posted = await postComment(reportBody(comment, page.line), {
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

interface PullHead {
  // `repo` is null once a fork's repository is deleted.
  head: { sha: string; repo?: { full_name: string } | null };
}

// The line the comment gives the architecture page: a link to the run's page artifact, or why there's none for a PR
// that changes the workflows. Nothing for a PR from a fork, or when the run uploaded no page.
async function pageLink(options: {
  call: GitHubCall;
  repository: string;
  pr: number;
  pull: PullHead;
  run: number | undefined;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}): Promise<{ line?: string; url?: string }> {
  const { call, repository, pr, pull, run, env, log } = options;
  if (pull.head.repo?.full_name.toLowerCase() !== repository.toLowerCase()) return {};
  try {
    // Checked here, not trusted from the run: a PR that changes the workflows could have uploaded any page.
    const files = await pullFiles(call, repository, pr);
    if (changesWorkflows(files)) return { line: pageLeftOut };
    // GitHub lists no more than this many of a PR's files, so a bigger PR might hide a change to the workflows.
    if (files.length >= filesListed) {
      log(`warning: no architecture page linked: #${pr} changes more files than GitHub lists`);
      return {};
    }
    if (run === undefined) return {};
    const listing = (await call(
      "GET",
      `/repos/${repository}/actions/runs/${run}/artifacts?name=${encodeURIComponent(pageArtifact)}`,
    )) as { artifacts?: Array<{ id: number; name: string; expired?: boolean }> };
    const artifact = listing.artifacts?.find((each) => each.name === pageArtifact && each.expired !== true);
    if (artifact === undefined) return {};
    // github.com's URL, which checks the reader can see the repo before it redirects to the file in Actions storage.
    const server = env.GITHUB_SERVER_URL || "https://github.com";
    const url = `${server}/${repository}/actions/runs/${run}/artifacts/${artifact.id}`;
    return {
      url,
      line: [
        "> [!IMPORTANT]",
        `> ### 🧭 [Review this PR's architecture page](${url})`,
        ">",
        "> Start here. The page shows the target's change, where the code changed, drift and the dynamic views, level by level, and opens in the browser. The rest of this comment summarises it.",
      ].join("\n"),
    };
  } catch (error) {
    // The page is extra: the comment and the status still go up without it.
    if (!(error instanceof GitHubError)) throw error;
    log(`warning: no architecture page linked: ${error.message}`);
    return {};
  }
}

async function readUpload(dir: string, name: string): Promise<string | undefined> {
  const path = join(dir, name);
  return existsSync(path) ? readFile(path, "utf8") : undefined;
}

// The report part of Bearing's comment, from what the conformance job wrote. Its guard markers are broken, so it can't
// pass for or close the guard's section, and it's cut to the report's share of the comment. `page`, the line `post`
// writes about the architecture page, goes above what the job wrote, where nothing it wrote can swallow it.
export function reportBody(comment: string, page?: string): string {
  const body = comment
    .replaceAll(guardStart, guardStart.replace("guard", "guard​"))
    .replaceAll(guardEnd, guardEnd.replace("guard", "guard​"));
  const rest = body.startsWith(reportMarker) ? body.slice(reportMarker.length).replace(/^\n+/, "") : body;
  const marked = [reportMarker, ...(page === undefined ? [] : [page]), rest].join("\n\n");
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
  const closed = Array.isArray(surplus.closed) ? surplus.closed.length : 0;
  const untraced = Array.isArray(surplus.untraced)
    ? surplus.untraced.reduce((sum, file) => sum + (Array.isArray(file?.functions) ? file.functions.length : 0), 0)
    : 0;
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const found = [
    ...(outside > 0 ? [`${count(outside, "file")} outside every component`] : []),
    ...(closed > 0 ? [`${count(closed, "component")} serving only closed requirements`] : []),
    ...(untraced > 0 ? [`${count(untraced, "exported function")} no tagged test calls`] : []),
  ];
  const description = `Surplus flagged${found.length > 0 ? `: ${found.join(", ")}` : ""}. Advisory only`;
  return description.slice(0, descriptionLimit);
}

// The run a `workflow_run` event is for, and the commit it checked.
async function eventRun(env: NodeJS.ProcessEnv): Promise<{ id?: number; head?: string }> {
  if (!env.GITHUB_EVENT_PATH) return {};
  try {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as {
      workflow_run?: { id?: number; head_sha?: string };
    };
    return { id: event.workflow_run?.id, head: event.workflow_run?.head_sha };
  } catch {
    return {};
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
    .option(
      "--run <id>",
      "the conformance run, whose architecture page to link; defaults, in GitHub Actions, to the workflow_run",
    )
    .action(async function (this: Command, dir: string, options: { head?: string; run?: string }) {
      if (options.run !== undefined && !/^[1-9]\d*$/.test(options.run)) {
        this.error(`error: "${options.run}" is not a workflow run ID`);
      }
      try {
        const event = await eventRun(process.env);
        const head = options.head ?? event.head;
        const run = options.run === undefined ? event.id : Number(options.run);
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
        const result = await post({
          dir,
          repository,
          head,
          token,
          ...(run === undefined ? {} : { run }),
          log: (message) => process.stderr.write(`${message}\n`),
        });
        const lines =
          result.skipped === undefined
            ? [
                `#${result.pr} at ${head.slice(0, 7)}: ${result.advisory}`,
                ...(result.commentUrl ? [result.commentUrl] : []),
                ...(result.pageUrl ? [`Architecture page: ${result.pageUrl}`] : []),
              ]
            : [`Nothing posted: ${result.skipped}`];
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (error) {
        if (error instanceof PostError || error instanceof GitHubError) this.error(`error: ${error.message}`);
        throw error;
      }
    });
}
