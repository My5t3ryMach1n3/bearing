import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChecks, type CheckReport } from "../src/check.js";
import { loadConfig } from "../src/config.js";
import { formatMermaid, type Overlay } from "../src/mermaid.js";
import { createProgram } from "../src/program.js";
import {
  buildOverlay,
  formatComment,
  gatherReport,
  overlayLimit,
  guardEnd,
  guardLimit,
  guardStart,
  postComment,
  pullRequestNumber,
  reportMarker,
} from "../src/report.js";
import { basketDir, basketRepo, basketVariants, git, variantRepo } from "./basket.js";

beforeEach(() => vi.stubEnv("BEARING_ISSUES_FILE", join(basketDir, "issues.json")));
afterEach(() => vi.unstubAllEnvs());

async function report(root: string) {
  const config = loadConfig(root);
  const check = await runChecks(config);
  const gathered = await gatherReport(config);
  return {
    check,
    ...gathered,
    comment: formatComment({ check, ...gathered }),
    overlay: buildOverlay({ check, ...gathered }),
  };
}

// Each edge as "source -> destination" with its mark, for comparing overlays.
const edgesOf = (overlay: Overlay) =>
  overlay.edges.map(
    (edge) => `${edge.source} -> ${edge.destination}${edge.mark === undefined ? "" : ` (${edge.mark})`}`,
  );
const marked = (overlay: Overlay) =>
  Object.fromEntries(overlay.nodes.flatMap((node) => (node.mark === undefined ? [] : [[node.id, node.mark]])));

// The PR's target change in the walkthrough's Wednesday, in workspace JSON: a share component the controller calls,
// a rewritten service description, and session restore no longer checking sign-ins itself.
function changeTarget(root: string) {
  const file = join(root, "architecture", "workspace.json");
  const workspace = JSON.parse(readFileSync(file, "utf8"));
  const basket = workspace.model.softwareSystems.find((system: { name: string }) => system.name === "Basket");
  const api = basket.containers.find((container: { name: string }) => container.name === "Basket API");
  const component = (name: string) => api.components.find((each: { name: string }) => each.name === name);
  api.components.push({
    id: "900",
    name: "Share service",
    description: "Emails a basket to a friend",
    properties: { "structurizr.dsl.identifier": "shareService", "bearing.path": "src/basket-api/share-service" },
    tags: "Element,Component",
  });
  component("Basket controller").relationships.push({
    id: "901",
    sourceId: component("Basket controller").id,
    destinationId: "900",
    description: "Shares baskets using",
    tags: "Relationship",
  });
  component("Basket service").description = "Adds, removes and prices basket items";
  const restore = component("Session restore");
  const auth = component("Auth middleware");
  restore.relationships = restore.relationships.filter(
    (relationship: { destinationId: string }) => relationship.destinationId !== auth.id,
  );
  writeFileSync(file, JSON.stringify(workspace));
}

describe("the overlay on the basket fixture", () => {
  // The issue's readability target: every seeded branch draws fewer than 15 elements.
  it.each(basketVariants)("stays under %s's readability limit", async (variant) => {
    const { overlay } = await report(variantRepo(variant));
    expect(overlay.nodes.length).toBeLessThan(overlayLimit);
  });

  it("draws controller-imports-repository's undeclared relationship beside the routes the target declares", async () => {
    const { overlay, comment } = await report(variantRepo("controller-imports-repository"));
    expect(overlay.nodes.map((node) => node.id)).toEqual([
      "basketController",
      "basketRepository",
      "basketService",
      "sessionRestore",
    ]);
    expect(edgesOf(overlay)).toEqual([
      "basketController -> basketRepository (drifted)",
      "basketController -> basketService",
      "basketService -> basketRepository",
      "basketController -> sessionRestore",
      "sessionRestore -> basketRepository",
    ]);
    expect(marked(overlay)).toEqual({});
    expect(comment).toContain(
      '  n0 -->|"imports, undeclared"| n1\n' +
        '  n0 -->|"Reads and changes baskets using"| n2\n' +
        '  n2 -->|"Loads and saves baskets using"| n1\n',
    );
    expect(comment).toContain("  linkStyle 0 stroke:#cf222e,stroke-width:2px\n");
  });

  it("draws redis-node's Redis cluster as a node the target doesn't have", async () => {
    const { overlay } = await report(variantRepo("redis-node"));
    expect(overlay.nodes).toEqual([
      {
        id: "aws_elasticache_cluster.basket",
        name: "aws_elasticache_cluster.basket",
        kind: "Not in the target: Amazon ElastiCache",
        group: "Production",
        mark: "drifted",
      },
    ]);
    expect(overlay.edges).toEqual([]);
  });

  it("draws wrong-place's trace beside the steps of #2's view it missed", async () => {
    const { overlay } = await report(variantRepo("wrong-place"));
    expect(edgesOf(overlay)).toEqual([
      "basketController -> basketService",
      "basketService -> basketRepository",
      "basketController -> sessionRestore (drifted)",
      "sessionRestore -> basketRepository (drifted)",
    ]);
    expect(overlay.edges[2]?.label).toBe("#2/AC1, #2/AC2 trace: addItem()");
  });

  it("draws nothing when nothing drifted", async () => {
    const { overlay, comment } = await report(variantRepo("untraced-helper"));
    expect(overlay.nodes).toEqual([]);
    expect(comment).toContain("Nothing has drifted from the target.");
    expect(comment).not.toContain("```mermaid");
  });

  it("leaves a target change to the target-change section, and draws only drift", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "share-basket");
    changeTarget(root);
    const { overlay, comment } = await report(root);
    // The target drops this relationship, but the code still imports it, so it's drift. What the target adds isn't.
    expect(edgesOf(overlay)).toContain("sessionRestore -> authMiddleware (drifted)");
    expect(overlay.nodes.map((node) => node.id)).not.toContain("shareService");
    expect(marked(overlay)).toEqual({});
    expect(comment).toContain("#### Components: what changes in Basket API");
  });
});

describe("the comment", () => {
  it("says which check failed when a branch changes a component's code and names no issue", async () => {
    const root = variantRepo("untraced-helper");
    const claim = join(root, ".bearing", "claims", "untraced-helper.yaml");
    writeFileSync(claim, readFileSync(claim, "utf8").replace('issues: ["#2"]', "issues: []"));
    const { comment } = await report(root);
    expect(comment).toContain("| Criteria coverage | ❌ failed | 1 component changed with no issue |\n");
    expect(comment).toContain("the branch changes code in basketService but names no issue");
  });

  it("summarises every check, then the overlay, then the failing checks' details", async () => {
    const { comment } = await report(variantRepo("controller-imports-repository"));
    expect(comment.startsWith(`${reportMarker}\n\n## Bearing: ❌ 2 blocking checks failed: Claim, Boundaries`)).toBe(
      true,
    );
    expect(comment).toContain(
      "| Target change | ⏭️ skipped | the branch doesn't change the target, so it's checked against main's |\n" +
        "| Claim | ❌ failed | 1 mismatch with `.bearing/claims/controller-imports-repository.yaml` |\n" +
        "| Boundaries | ❌ failed | 1 relationship the target doesn't declare |\n" +
        "| Deployment | ✅ passed | the Terraform matches the target's Production deployment |\n" +
        "| Criteria coverage | ✅ passed | 2 of 2 criteria covered |\n" +
        "| Trace paths | ✅ passed | 2 tagged tests follow their issue's dynamic view |\n" +
        "| Surplus (advisory) | ⚠️ flagged | 6 exported functions no tagged test calls |\n",
    );
    const order = ["### Checks", "### Overlay", "<summary>Claim: failed", "<summary>Boundaries: failed"];
    const positions = order.map((text) => comment.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(comment).not.toContain("### ⚠️ Target change");
    expect(comment).toContain("| `src/basket-api/basket-controller/index.ts` | `basketController` |");
  });

  it("puts the model diff first in target-change mode", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "share-basket");
    changeTarget(root);
    const { comment } = await report(root);
    expect(comment.indexOf("### ⚠️ Target change")).toBeGreaterThan(0);
    expect(comment.indexOf("### ⚠️ Target change")).toBeLessThan(comment.indexOf("### Checks"));
    expect(comment).toContain("Changed: `architecture/workspace.json`\n");
    expect(comment).toContain(
      "| | Added | Removed | Drifted |\n" +
        "| --- | --- | --- | --- |\n" +
        "| Elements | `shareService` |  | `basketService` (description) |\n" +
        "| Relationships | `basketController->shareService` | `sessionRestore->authMiddleware` |  |\n" +
        "| Dynamic views |  |  | `req-4` (steps) |\n",
    );
    expect(comment).toContain("No ADR in this PR gives the reason for the change or the alternatives considered.");
  });

  it("shows the ADRs that give the target change's reason, after the model diff", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "share-basket");
    changeTarget(root);
    mkdirSync(join(root, "architecture", "adrs"), { recursive: true });
    writeFileSync(join(root, "architecture", "adrs", "template.md"), "# NNNN. Decision title\n");
    writeFileSync(
      join(root, "architecture", "adrs", "0002-share-service.md"),
      "# 0002. Share baskets from their own component\n\n## Alternatives considered\n\n- In the basket service: it would send email.\n",
    );
    const { comment } = await report(root);
    expect(comment).toContain(
      "<details open><summary>0002. Share baskets from their own component (<code>architecture/adrs/0002-share-service.md</code>)</summary>\n\n" +
        "# 0002. Share baskets from their own component\n\n## Alternatives considered\n\n- In the basket service: it would send email.\n\n</details>",
    );
    expect(comment).not.toContain("NNNN. Decision title");
    expect(comment).not.toContain("No ADR in this PR");
    expect(comment.indexOf("<details open>")).toBeLessThan(comment.indexOf("### Checks"));
  });

  it("is in target-change mode for a workflow change, though the model is unchanged", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "ci");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "bearing.yml"), "on: pull_request\n");
    const { comment } = await report(root);
    expect(comment).toContain("Changed: `.github/workflows/bearing.yml`\n\nThe model itself is unchanged.");
  });

  it("isn't in target-change mode for a claims file alone", async () => {
    const { targetFiles } = await report(variantRepo("untraced-helper"));
    expect(targetFiles).toEqual([]);
  });

  it("links to the Structurizr static site", async () => {
    const root = variantRepo("untraced-helper");
    const config = loadConfig(root);
    const check = await runChecks(config);
    const comment = formatComment({ check, ...(await gatherReport(config)), siteUrl: "https://example.com/run/1" });
    expect(comment).toMatch(
      /\[Every view of this PR's target in Structurizr\]\(https:\/\/example\.com\/run\/1\), as a static site\.\n$/,
    );
  });

  it("keeps under GitHub's comment limit by dropping the details", async () => {
    const root = variantRepo("untraced-helper");
    const config = loadConfig(root);
    const check = await runChecks(config);
    const surplus = check.checks[7];
    surplus.outside = Array.from({ length: 5000 }, (_, index) => `src/generated/file-${index}.ts`);
    const comment = formatComment({ check, ...(await gatherReport(config)) });
    expect(comment.length).toBeLessThan(65_536);
    expect(comment).toContain("The details are too long for a comment; run `bearing check` to see them.");
  });

  it("drops the sequence diagrams after the details, keeping the summary and the level diagrams", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "share-basket");
    changeTarget(root);
    const config = loadConfig(root);
    const check = await runChecks(config);
    const gathered = await gatherReport(config);
    const view = gathered.target.dynamicViews.get("req-2")!;
    const step = view.steps[0]!;
    const steps = Array.from({ length: 4000 }, () => ({ ...step, description: "x".repeat(40) }));
    gathered.target.dynamicViews.set("req-99", { ...view, id: "req-99", steps });
    const comment = formatComment({ check, ...gathered });
    expect(comment.length).toBeLessThanOrEqual(65_536 - guardLimit);
    expect(comment).toContain("The dynamic views are too long for the comment");
    expect(comment).toContain("#### Components: what changes in Basket API");
    expect(comment).toContain("New dynamic view: #99.");
  });
});

describe("formatMermaid", () => {
  it("escapes what Mermaid would read as syntax", () => {
    const overlay: Overlay = {
      nodes: [
        { id: "a", name: 'The "A" <service>', kind: "Component" },
        { id: "b", name: "B", kind: "" },
      ],
      edges: [{ source: "a", destination: "b", label: "#2/AC1 | x" }],
    };
    expect(formatMermaid(overlay)).toBe(
      "flowchart LR\n" +
        '  n0["The #34;A#34; #60;service#62;<br/>[Component]"]\n' +
        '  n1["B"]\n' +
        '  n0 -->|"#35;2/AC1 #124; x"| n1',
    );
  });
});

// A fake GitHub issue comments API, holding `existing` comments.
function fakeGitHub(existing: Array<{ id: number; body: string }>) {
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method: init.method ?? "GET", url, ...(body === undefined ? {} : { body }) });
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    const json =
      init.method === "GET"
        ? existing.slice((page - 1) * 100, page * 100)
        : { html_url: `https://github.com/acme/basket/pull/7#issuecomment-${init.method === "POST" ? 1 : 2}` };
    return new Response(JSON.stringify(json), { status: init.method === "POST" ? 201 : 200 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const api = "https://api.github.com/repos/acme/basket";

describe("postComment", () => {
  it("posts a new comment when the PR has none of Bearing's", async () => {
    const github = fakeGitHub([{ id: 5, body: "LGTM" }]);
    const posted = await postComment(`${reportMarker}\n\nhi\n`, {
      repository: "acme/basket",
      pr: 7,
      token: "t",
      env: {},
      fetch: github.fetch,
    });
    expect(posted).toEqual({ url: "https://github.com/acme/basket/pull/7#issuecomment-1", updated: false });
    expect(github.requests).toEqual([
      { method: "GET", url: `${api}/issues/7/comments?per_page=100&page=1` },
      { method: "POST", url: `${api}/issues/7/comments`, body: { body: `${reportMarker}\n\nhi\n` } },
    ]);
  });

  it("updates Bearing's comment in place, looking past the first page", async () => {
    const others = Array.from({ length: 100 }, (_, index) => ({ id: index, body: "LGTM" }));
    const github = fakeGitHub([...others, { id: 321, body: `${reportMarker}\nold` }]);
    const posted = await postComment(`${reportMarker}\nnew`, {
      repository: "acme/basket",
      pr: 7,
      token: "t",
      env: {},
      fetch: github.fetch,
    });
    expect(posted.updated).toBe(true);
    expect(github.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${api}/issues/7/comments?per_page=100&page=1`,
      `GET ${api}/issues/7/comments?per_page=100&page=2`,
      `PATCH ${api}/issues/comments/321`,
    ]);
  });

  it("keeps the guard's section above the report", async () => {
    const guard = `${guardStart}\n### Target change\n${guardEnd}`;
    const github = fakeGitHub([{ id: 321, body: `${reportMarker}\n\n${guard}\n\n## Bearing: old\n` }]);
    await postComment(`${reportMarker}\n\n## Bearing: new\n`, {
      repository: "acme/basket",
      pr: 7,
      token: "t",
      env: {},
      fetch: github.fetch,
    });
    expect(github.requests.at(-1)).toEqual({
      method: "PATCH",
      url: `${api}/issues/comments/321`,
      body: { body: `${reportMarker}\n\n${guard}\n\n## Bearing: new\n` },
    });
  });

  it("says what GitHub refused", async () => {
    const fetch = (async () => new Response("{}", { status: 403, statusText: "Forbidden" })) as typeof globalThis.fetch;
    await expect(postComment("x", { repository: "acme/basket", pr: 7, token: "t", env: {}, fetch })).rejects.toThrow(
      `GitHub returned 403 Forbidden for GET ${api}/issues/7/comments?per_page=100&page=1`,
    );
  });
});

describe("pullRequestNumber", () => {
  it("reads the event's pull request, then the merge ref", async () => {
    const event = join(mkdtempSync(join(tmpdir(), "bearing-event-")), "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 12 } }));
    expect(await pullRequestNumber({ GITHUB_EVENT_PATH: event })).toBe(12);
    expect(await pullRequestNumber({ GITHUB_REF: "refs/pull/34/merge" })).toBe(34);
    expect(await pullRequestNumber({ GITHUB_REF: "refs/heads/main" })).toBeUndefined();
  });
});

describe("bearing report", () => {
  let root: string;
  beforeEach(() => {
    root = variantRepo("controller-imports-repository");
    vi.spyOn(process, "cwd").mockReturnValue(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });

  async function run(...args: string[]) {
    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((text) => ((stdout += String(text)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((text) => ((stderr += String(text)), true));
    const program = createProgram();
    for (const command of [program, ...program.commands]) {
      command.exitOverride().configureOutput({ writeErr: (text) => (stderr += text) });
    }
    try {
      await program.parseAsync(["report", ...args], { from: "user" });
    } catch {
      // Commander's exitOverride throws on this.error(); stderr has the message.
    }
    return { stdout, stderr };
  }

  it("prints the comment without failing, even when checks fail", async () => {
    const { stdout } = await run();
    expect(stdout.startsWith(`${reportMarker}\n\n## Bearing: ❌ 2 blocking checks failed`)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("reads the results `bearing check --json` wrote", async () => {
    const check: CheckReport = await runChecks(loadConfig(root));
    check.checks[3].undeclared = [];
    check.checks[3].status = "passed";
    const file = join(root, "check.json");
    writeFileSync(file, JSON.stringify(check));
    const { stdout } = await run("--check", file);
    expect(stdout).toContain("## Bearing: ❌ 1 blocking check failed: Claim");
  });

  it("fails the comment, not only the job, when the target is invalid", async () => {
    const check: CheckReport = await runChecks(loadConfig(root));
    check.checks[0] = {
      check: "valid",
      status: "failed",
      blocking: true,
      model: "architecture/workspace.dsl",
      problems: [{ rule: "dynamic-view", id: "#5", message: 'open story has no dynamic view; add one keyed "req-5"' }],
    };
    const file = join(root, "check.json");
    writeFileSync(file, JSON.stringify(check));
    const { stdout } = await run("--check", file);
    expect(stdout).toContain("## Bearing: ❌ 3 blocking checks failed: Target valid, Claim, Boundaries");
    expect(stdout).toContain("| Target valid | ❌ failed | 1 broken rule in `architecture/workspace.dsl` |");
    expect(stdout).toContain("#5: open story has no dynamic view");
  });

  it("posts the comment on the event's pull request", async () => {
    const github = fakeGitHub([]);
    vi.stubGlobal("fetch", github.fetch);
    vi.stubEnv("GITHUB_TOKEN", "t");
    vi.stubEnv("GITHUB_REPOSITORY", "acme/basket");
    vi.stubEnv("GITHUB_REF", "refs/pull/7/merge");
    // CI sets its own event, for this PR.
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    const { stdout, stderr } = await run("--post");
    expect(stderr).toBe("Posted https://github.com/acme/basket/pull/7#issuecomment-1\n");
    expect(github.requests[1]).toEqual({ method: "POST", url: `${api}/issues/7/comments`, body: { body: stdout } });
  });

  it("says which pull request it needs outside Actions", async () => {
    vi.stubEnv("GITHUB_REF", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    const { stderr } = await run("--post");
    expect(stderr).toContain("error: can't tell which pull request to post on; pass --pr");
  });
});
