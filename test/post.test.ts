import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { actionsBot } from "../src/guard.js";
import { init } from "../src/init.js";
import { advisoryDescription, post, reportBody } from "../src/post.js";
import { guardEnd, guardStart, reportMarker, splitComment } from "../src/report.js";
import { version } from "../src/version.js";

const api = "https://api.github.com/repos/acme/basket";
const head = "abc1234def";

interface Comment {
  id: number;
  body: string;
  user: { login: string };
}

// A fake GitHub API for one PR, #7, at `head`: its comments and statuses.
function fakeGitHub(comments: Comment[] = [], at = head) {
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const path = url.slice(api.length);
    const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
    requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/pulls/7") return json({ head: { sha: at } });
    if (path.startsWith("/issues/7/comments")) {
      if (method === "GET") return json(comments);
      return json({ html_url: "https://github.com/acme/basket/pull/7#issuecomment-1" }, 201);
    }
    if (path.startsWith("/issues/comments/")) {
      return json({ html_url: `https://github.com/acme/basket/pull/7#issuecomment-${path.split("/").at(-1)}` });
    }
    if (path === `/statuses/${head}`) return json({}, 201);
    return json({ message: "Not Found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

// What the conformance job uploads.
function upload(files: { pr?: string; comment?: string; check?: object | string }): string {
  const dir = mkdtempSync(join(tmpdir(), "bearing-post-"));
  if (files.pr !== undefined) writeFileSync(join(dir, "pr"), files.pr);
  if (files.comment !== undefined) writeFileSync(join(dir, "comment.md"), files.comment);
  if (files.check !== undefined) {
    writeFileSync(join(dir, "check.json"), typeof files.check === "string" ? files.check : JSON.stringify(files.check));
  }
  return dir;
}

const run = (dir: string, github: ReturnType<typeof fakeGitHub>) =>
  post({ dir, repository: "acme/basket", head, token: "t", env: {}, fetch: github.fetch });

const passed = { passed: true, checks: [{ check: "surplus", status: "passed", outside: [], untraced: [] }] };

describe("post", () => {
  it("updates the bot's comment under the guard's section and sets bearing/advisory", async () => {
    const guard = `${guardStart}\nthe diffs\n${guardEnd}`;
    const github = fakeGitHub([
      { id: 1, body: `${reportMarker}\nforged`, user: { login: "mallory" } },
      { id: 2, body: `${reportMarker}\n\n${guard}\n\n## Bearing: old\n`, user: { login: actionsBot } },
    ]);
    const dir = upload({ pr: "7\n", comment: `${reportMarker}\n\n## Bearing: new\n`, check: passed });
    const result = await run(dir, github);
    expect(result).toMatchObject({ pr: 7, advisory: "Surplus: nothing flagged" });
    const patch = github.requests.find(({ method }) => method === "PATCH");
    expect(patch?.path).toBe("/issues/comments/2");
    expect(patch?.body).toEqual({ body: `${reportMarker}\n\n${guard}\n\n## Bearing: new\n` });
    expect(github.requests.at(-1)).toEqual({
      method: "POST",
      path: `/statuses/${head}`,
      body: {
        state: "success",
        context: "bearing/advisory",
        description: "Surplus: nothing flagged",
        target_url: "https://github.com/acme/basket/pull/7#issuecomment-2",
      },
    });
  });

  it("posts nothing when the PR's head isn't the commit that was checked", async () => {
    const github = fakeGitHub([], "fff9999aaa");
    const result = await run(upload({ pr: "7", comment: "## Bearing\n", check: passed }), github);
    expect(result.skipped).toBe("#7 is at fff9999, not the abc1234 checked");
    expect(github.requests.map(({ method }) => method)).toEqual(["GET"]);
  });

  it("refuses an upload with no PR number in it", async () => {
    const github = fakeGitHub();
    await expect(run(upload({ pr: "7/../../8" }), github)).rejects.toThrow("doesn't hold a pull request number");
    await expect(run(upload({}), github)).rejects.toThrow("doesn't hold a pull request number");
    expect(github.requests).toEqual([]);
  });

  it("still sets bearing/advisory when the conformance job wrote no comment or results", async () => {
    const github = fakeGitHub();
    const result = await run(upload({ pr: "7", check: "" }), github);
    expect(result.commentUrl).toBeUndefined();
    expect(github.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /pulls/7",
      `POST /statuses/${head}`,
    ]);
    expect(github.requests.at(-1)?.body).toMatchObject({ description: "No check results: see the conformance job" });
  });
});

describe("reportBody", () => {
  it("can't pass for or close the guard's section", () => {
    const forged = `${reportMarker}\n\n${guardStart}\nfake diffs\n${guardEnd}\n\n## Bearing\n`;
    const parts = splitComment(reportBody(forged));
    expect(parts.guard).toBeUndefined();
    expect(parts.report).not.toContain(guardStart);
    expect(parts.report).not.toContain(guardEnd);
  });

  it("cuts a comment too long for the report's share", () => {
    const body = reportBody(`## Bearing\n\n${"x".repeat(100_000)}`);
    expect(body.startsWith(reportMarker)).toBe(true);
    expect(body.length).toBeLessThan(65_536 - 16_384);
    expect(body).toContain("too long for a comment");
  });
});

describe("advisoryDescription", () => {
  it("counts what Surplus flagged", () => {
    const flagged = {
      checks: [
        {
          check: "surplus",
          status: "flagged",
          outside: ["src/a.ts"],
          untraced: [{ file: "src/b.ts", component: "b", functions: ["one", "two"] }],
        },
      ],
    };
    expect(advisoryDescription(JSON.stringify(flagged))).toBe(
      "Surplus flagged: 1 file outside every component, 2 exported functions no tagged test calls. Advisory only",
    );
  });

  it("says when Surplus is off, and survives results that aren't `bearing check --json`", () => {
    expect(advisoryDescription(JSON.stringify({ checks: [{ check: "surplus", status: "skipped" }] }))).toBe(
      "Surplus skipped",
    );
    for (const text of [undefined, "", "null", '{"checks": 3}', '{"checks": [null]}']) {
      expect(advisoryDescription(text).length).toBeLessThanOrEqual(140);
    }
  });
});

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

function action(name: string) {
  const text = readFileSync(new URL(`../actions/${name}/action.yml`, import.meta.url), "utf8");
  return { text, steps: (parse(text) as { runs: { using: string; steps: Step[] } }).runs.steps };
}

describe("the conformance workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "bearing-conformance-"));
  init(root);
  const text = readFileSync(join(root, ".github/workflows/bearing-conformance.yml"), "utf8");
  const workflow = parse(text) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: { conformance: { name: string; steps: Step[] } };
  };
  const { text: actionText, steps } = action("conformance");

  it("runs on pull_request with a read-only token", () => {
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(workflow.permissions).toEqual({ contents: "read", issues: "read" });
    expect(workflow.jobs.conformance.name).toBe("bearing/conformance");
  });

  it("checks out the PR's head with its history, and runs this version's conformance action", () => {
    const checkout = workflow.jobs.conformance.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with).toMatchObject({ ref: "${{ github.event.pull_request.head.sha }}", "fetch-depth": 0 });
    expect(workflow.jobs.conformance.steps.at(-1)?.uses).toBe(`My5t3ryMach1n3/bearing/actions/conformance@v${version}`);
  });

  it("re-derives everything, never reading traces the branch commits", () => {
    const runs = steps.map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("rm -rf .bearing/traces");
    for (const command of ["validate", "test", "derive", "check", "report"]) {
      expect(runs).toMatch(new RegExp(`^\\s*bearing ${command}\\b`, "m"));
    }
    const index = (pattern: RegExp) => steps.findIndex((step) => pattern.test(step.run ?? ""));
    expect(index(/rm -rf \.bearing\/traces/)).toBeLessThan(index(/^bearing test$/m));
  });

  it("gives Bearing the token to read requirements, and expands nothing from the PR into a script", () => {
    for (const step of steps.filter((step) =>
      /^\s*bearing (validate|test|derive|check|report)/m.test(step.run ?? ""),
    )) {
      expect(step.env?.GH_TOKEN).toBe("${{ inputs.token }}");
    }
    for (const step of [...workflow.jobs.conformance.steps, ...steps]) expect(step.run ?? "").not.toContain("${{");
    expect(actionText).not.toMatch(/head_ref|head\.ref|\.title|\.body/);
  });

  it("uploads the files `bearing post` reads", () => {
    const report = steps.find((step) => step.run?.includes("bearing report"))?.run ?? "";
    for (const file of ['"$dir/pr"', '"$dir/comment.md"', '"$dir/check.json"']) expect(report).toContain(file);
    const uploaded = steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
    expect(uploaded?.with).toMatchObject({ name: "bearing-report", path: "${{ runner.temp }}/bearing/report/" });
  });
});

describe("the report workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "bearing-report-"));
  init(root);
  const text = readFileSync(join(root, ".github/workflows/bearing-report.yml"), "utf8");
  const workflow = parse(text) as {
    on: { workflow_run?: { workflows: string[] } };
    jobs: { report: { steps: Step[] } };
  };
  const conformance = parse(readFileSync(join(root, ".github/workflows/bearing-conformance.yml"), "utf8")) as {
    name: string;
  };
  const { text: actionText, steps } = action("report");

  it("runs after the conformance workflow, from the default branch", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_run"]);
    expect(workflow.on.workflow_run?.workflows).toEqual([conformance.name]);
  });

  it("never checks out or runs the PR's code", () => {
    for (const step of [...workflow.jobs.report.steps, ...steps]) {
      expect(step.uses?.startsWith("actions/checkout") ?? false).toBe(false);
      expect(step.run ?? "").not.toContain("${{");
    }
    for (const each of [text, actionText]) expect(each).not.toMatch(/head_branch|head\.ref|refs\/pull/);
  });

  it("runs this version's report action, which posts with `bearing post`", () => {
    expect(workflow.jobs.report.steps.at(-1)?.uses).toBe(`My5t3ryMach1n3/bearing/actions/report@v${version}`);
    const download = steps.find((step) => step.uses?.startsWith("actions/download-artifact"));
    expect(download?.with).toMatchObject({ name: "bearing-report", "run-id": "${{ github.event.workflow_run.id }}" });
    expect(steps.at(-1)?.run).toBe('bearing post "$RUNNER_TEMP/bearing/report"');
  });
});

describe("the actions", () => {
  it("install the Bearing in their own package.json", () => {
    for (const name of ["conformance", "report", "guard"]) {
      const install = action(name).steps[0]?.run ?? "";
      expect(install, name).toContain('"$GITHUB_ACTION_PATH/../../package.json"');
      expect(install, name).toContain('"bearing-cli@$version"');
    }
  });
});
