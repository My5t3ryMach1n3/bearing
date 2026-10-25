import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { actionsBot, formatGuard, guard, targetFiles, type PullFile } from "../src/guard.js";
import { init } from "../src/init.js";
import { guardEnd, guardLimit, guardStart, reportMarker, splitComment } from "../src/report.js";
import { version } from "../src/version.js";

const api = "https://api.github.com/repos/acme/basket";
const config = "version: 1\nmodel: model/workspace.dsl\nlanguage: typescript\n";

interface Comment {
  id: number;
  body: string;
  user: { login: string };
}

// A fake GitHub API for one PR, #7: its files, the base branch's config, labels, comments and statuses.
function fakeGitHub(options: { files: PullFile[]; comments?: Comment[]; config?: string | null; labelled?: boolean }) {
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const comments = options.comments ?? [];
  const fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const path = url.slice(api.length);
    const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
    requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/pulls/7") return json({ head: { sha: "abc1234def" }, base: { sha: "base999", ref: "main" } });
    if (path.startsWith("/contents/.bearing/config.yaml")) {
      return options.config === null
        ? json({}, 404)
        : json({ content: Buffer.from(options.config ?? config).toString("base64") });
    }
    if (path.startsWith("/pulls/7/files")) return json(options.files.slice((page - 1) * 100, page * 100));
    if (path === "/issues/7/labels") return json([{ name: "architecture-change" }]);
    if (path === "/issues/7/labels/architecture-change") return options.labelled ? json([]) : json({}, 404);
    if (path.startsWith("/issues/7/comments")) {
      if (method === "GET") return json(comments.slice((page - 1) * 100, page * 100));
      return json({ html_url: "https://github.com/acme/basket/pull/7#issuecomment-1" }, 201);
    }
    if (path.startsWith("/issues/comments/")) {
      if (method === "DELETE") return new Response(null, { status: 204 });
      return json({ html_url: `https://github.com/acme/basket/pull/7#issuecomment-${path.split("/").at(-1)}` });
    }
    if (path === "/statuses/abc1234def") return json({}, 201);
    return json({ message: "Not Found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const run = (github: ReturnType<typeof fakeGitHub>) =>
  guard({ repository: "acme/basket", pr: 7, token: "t", env: {}, fetch: github.fetch });

const file = (filename: string, patch = "@@ -1 +1 @@\n-a\n+b", status = "modified"): PullFile => ({
  filename,
  status,
  patch,
});

describe("targetFiles", () => {
  it("takes the model's folder, .bearing/ except claims, and the workflows", () => {
    const files = [
      file("model/workspace.dsl"),
      file("model/adrs/0002-email.md"),
      file(".bearing/config.yaml"),
      file(".bearing/claims/7-email.yaml"),
      file(".github/workflows/bearing-guard.yml"),
      file(".github/CODEOWNERS"),
      file("modelling/notes.md"),
      file("architecture/workspace.dsl"),
      file("src/basket-api/index.ts"),
      { ...file("docs/old.dsl", "", "renamed"), previous_filename: "model/old.dsl" },
    ];
    expect(targetFiles(files, "model/workspace.dsl").map((each) => each.filename)).toEqual([
      "model/workspace.dsl",
      "model/adrs/0002-email.md",
      ".bearing/config.yaml",
      ".github/workflows/bearing-guard.yml",
      "docs/old.dsl",
    ]);
  });

  it("takes only the model file when it sits at the repo root", () => {
    const files = [file("workspace.dsl"), file("workspace.json")];
    expect(targetFiles(files, "workspace.dsl").map((each) => each.filename)).toEqual(["workspace.dsl"]);
  });
});

describe("formatGuard", () => {
  it("says nothing when the target is unchanged", () => {
    expect(formatGuard([], "main")).toBeUndefined();
  });

  it("can't be closed early by the PR's patch", () => {
    const patch = `@@ -1 +1 @@\n+\`\`\`\`\n+${guardEnd}\n+<b>`;
    const section = formatGuard([file("model/workspace.dsl", patch)], "main") ?? "";
    expect(section.startsWith(guardStart)).toBe(true);
    expect(section.indexOf(guardEnd)).toBe(section.length - guardEnd.length);
    expect(section).toContain("`````diff\n");
    expect(splitComment(`${reportMarker}\n\n${section}\n\n## Bearing: ok\n`)).toEqual({
      guard: section,
      report: "## Bearing: ok\n",
    });
  });

  it("stops adding diffs at the guard's limit", () => {
    const big = `@@ -1 +1 @@\n${"+x\n".repeat(guardLimit / 6)}`;
    const section = formatGuard([file("model/a.dsl", big), file("model/b.dsl", big), file("model/c.dsl")], "main");
    expect(section?.length).toBeLessThanOrEqual(guardLimit);
    expect(section).toContain("<code>model/a.dsl</code>");
    expect(section).toContain("<code>model/c.dsl</code>");
    expect(section).toContain("Files changed tab for `model/b.dsl`");
  });
});

describe("guard", () => {
  it("labels a target change, puts its diffs atop Bearing's comment and says so in bearing/target", async () => {
    const report = `${reportMarker}\n\n## Bearing: ✅ All blocking checks passed\n`;
    const github = fakeGitHub({
      files: [file("src/basket-api/index.ts"), file("model/workspace.dsl"), file(".bearing/claims/x.yaml")],
      comments: [
        // Anyone can write a comment that starts with the marker; the guard only edits its own.
        { id: 1, body: `${reportMarker}\nfake`, user: { login: "mallory" } },
        { id: 2, body: report, user: { login: actionsBot } },
      ],
    });
    const result = await run(github);
    expect(result.targetFiles.map((each) => each.filename)).toEqual(["model/workspace.dsl"]);
    expect(github.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /pulls/7",
      "GET /contents/.bearing/config.yaml?ref=base999",
      "GET /pulls/7/files?per_page=100&page=1",
      "POST /issues/7/labels",
      "GET /issues/7/comments?per_page=100&page=1",
      "PATCH /issues/comments/2",
      "POST /statuses/abc1234def",
    ]);
    expect(github.requests[3]?.body).toEqual({ labels: ["architecture-change"] });
    const body = String(github.requests[5]?.body?.body);
    expect(body.startsWith(`${reportMarker}\n\n${guardStart}\n### ⚠️ Target change`)).toBe(true);
    expect(body).toContain("<code>model/workspace.dsl</code> (modified)");
    expect(body).toContain("```diff\n@@ -1 +1 @@\n-a\n+b\n```");
    expect(body.endsWith(`${guardEnd}\n\n## Bearing: ✅ All blocking checks passed\n`)).toBe(true);
    expect(github.requests[6]?.body).toEqual({
      state: "success",
      context: "bearing/target",
      description: "Target change in 1 file: merging approves it. Read its diff first",
      target_url: "https://github.com/acme/basket/pull/7#issuecomment-2",
    });
  });

  it("flags a PR that edits the guard's own workflow, which runs from the base branch regardless", async () => {
    const github = fakeGitHub({ files: [file(".github/workflows/bearing-guard.yml", "@@ -1 +1 @@\n-on:\n+on: {}")] });
    const result = await run(github);
    expect(result.description).toMatch(/^Target change in 1 file/);
    expect(github.requests.some(({ path }) => path === "/issues/7/labels")).toBe(true);
    const comment = github.requests.find(({ method, path }) => method === "POST" && path === "/issues/7/comments");
    expect(String(comment?.body?.body)).toMatch(new RegExp(`^${reportMarker}\\n\\n${guardStart}`));
  });

  it("clears its label and section once the PR no longer changes the target, leaving the report", async () => {
    const guarded = `${reportMarker}\n\n${guardStart}\nold\n${guardEnd}\n\n## Bearing: report\n`;
    const github = fakeGitHub({
      files: [file("src/basket-api/index.ts")],
      comments: [{ id: 2, body: guarded, user: { login: actionsBot } }],
      labelled: true,
    });
    const result = await run(github);
    expect(result.description).toBe("Target unchanged");
    expect(github.requests.map(({ method, path }) => `${method} ${path}`)).toContain(
      "DELETE /issues/7/labels/architecture-change",
    );
    expect(github.requests.find(({ method }) => method === "PATCH")?.body).toEqual({
      body: `${reportMarker}\n\n## Bearing: report\n`,
    });
    expect(github.requests.at(-1)?.body).toEqual({
      state: "success",
      context: "bearing/target",
      description: "Target unchanged",
    });
  });

  it("deletes a comment that held only its section, and posts none for an unchanged target", async () => {
    const onlyGuard = fakeGitHub({
      files: [],
      comments: [{ id: 3, body: `${reportMarker}\n\n${guardStart}\nold\n${guardEnd}\n`, user: { login: actionsBot } }],
    });
    await run(onlyGuard);
    expect(onlyGuard.requests.map(({ method, path }) => `${method} ${path}`)).toContain("DELETE /issues/comments/3");

    const none = fakeGitHub({ files: [file("src/a.ts")] });
    await run(none);
    expect(
      none.requests.filter(({ path }) => path.startsWith("/issues/7/comments")).map(({ method }) => method),
    ).toEqual(["GET"]);
  });

  it("uses the base branch's model path, falling back to architecture/ when it has no config", async () => {
    const github = fakeGitHub({ files: [file("architecture/workspace.dsl")], config: null });
    const result = await run(github);
    expect(result.targetFiles).toHaveLength(1);
  });

  it("reads every page of the PR's files", async () => {
    const files = [...Array.from({ length: 100 }, (_, index) => file(`src/${index}.ts`)), file("model/workspace.dsl")];
    const github = fakeGitHub({ files });
    const result = await run(github);
    expect(result.targetFiles.map((each) => each.filename)).toEqual(["model/workspace.dsl"]);
  });
});

describe("the guard workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "bearing-guard-"));
  init(root);
  const text = readFileSync(join(root, ".github/workflows/bearing-guard.yml"), "utf8");
  const workflow = parse(text) as {
    on: Record<string, unknown>;
    jobs: { guard: { steps: Step[] } };
  };
  const actionText = readFileSync(new URL("../actions/guard/action.yml", import.meta.url), "utf8");
  const action = parse(actionText) as { runs: { steps: Step[] } };
  const steps = [...workflow.jobs.guard.steps, ...action.runs.steps];

  // pull_request_target runs the workflow as it is on the base branch, so a PR's edits to it don't apply to itself.
  it("runs only on pull_request_target", () => {
    expect(Object.keys(workflow.on)).toEqual(["pull_request_target"]);
  });

  it("never checks out or runs the PR's code", () => {
    expect(steps.some((step) => step.uses?.startsWith("actions/checkout"))).toBe(false);
    for (const each of [text, actionText]) expect(each).not.toMatch(/head\.(sha|ref)|merge_commit_sha|refs\/pull/);
    // Nothing from the PR is expanded into a script, where its title or branch name could inject a command.
    for (const step of steps) expect(step.run ?? "").not.toContain("${{");
  });

  it("runs this version's guard action, which runs `bearing guard`", () => {
    expect(workflow.jobs.guard.steps.at(-1)?.uses).toBe(`My5t3ryMach1n3/bearing/actions/guard@v${version}`);
    expect(action.runs.steps.at(-1)?.run).toBe("bearing guard");
  });
});

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
