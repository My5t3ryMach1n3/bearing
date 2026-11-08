import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChecks, type CheckReport } from "../src/check.js";
import { codeChanges, functionalFile, parseNumstat, sourceFiles, type FileChange } from "../src/code-changes.js";
import { loadConfig } from "../src/config.js";
import { modelFromWorkspace, type Element, type Model } from "../src/model.js";
import { appearance, buildPageData, elementStyles, type PageInputs } from "../src/page-data.js";
import { modesOf, shown } from "../src/page-modes.js";
import { gatherReport } from "../src/report.js";
import { basketDir, basketRepo, git, variantRepo } from "./basket.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "target-changes", `${name}.json`), "utf8"));
const load = (name: string) => modelFromWorkspace(fixture(name));

// Every check skipped, for a test to fill in the ones it needs.
function skipped(): CheckReport {
  const base = { status: "skipped" as const, blocking: true as const, reason: "not run" };
  return {
    passed: true,
    checks: [
      { ...base, check: "valid", model: "architecture/workspace.dsl", problems: [] },
      { ...base, check: "target", base: "main", proposed: [], moved: [] },
      { ...base, check: "claim", mismatches: [] },
      { ...base, check: "boundaries", undeclared: [], queues: [] },
      { ...base, check: "deployment", added: [], removed: [], drifted: [], unknown: [] },
      { ...base, check: "coverage", issues: [], criteria: [], recorded: 0 },
      { ...base, check: "paths", issues: [], views: [] },
      { check: "surplus", status: "skipped", blocking: false, outside: [], closed: [], untraced: [], traced: false },
    ],
  };
}

const sharingFiles = (): FileChange[] => [
  { path: "src/basket-api/basket-sharing/index.ts", added: 120, removed: 0 },
  { path: "src/basket-api/basket-sharing/link.ts", added: 30, removed: 0 },
  { path: "src/basket-api/basket-controller/index.ts", added: 10, removed: 4 },
  { path: "src/basket-api/basket-controller/logo.png.ts", added: 0, removed: 0, binary: true },
  { path: "src/basket-api/utils/email-template.ts", added: 46, removed: 0 },
];

// The sharing design (basket#16) on top of the initial target, with the controller importing the repository.
function sharingInputs(overrides: Partial<PageInputs> = {}): PageInputs {
  const check = skipped();
  check.checks[3] = {
    check: "boundaries",
    status: "failed",
    blocking: true,
    undeclared: [
      {
        id: "basketController->basketRepository",
        source: "basketController",
        destination: "basketRepository",
        imports: [
          { file: "src/basket-api/basket-controller/index.ts", line: 3, module: "../basket-repository/index.js" },
        ],
      },
    ],
    queues: [],
  };
  return {
    check,
    target: load("sharing"),
    forked: load("initial"),
    targetFiles: ["architecture/workspace.dsl"],
    adrs: [
      {
        path: "architecture/adrs/0004-share-emails-through-an-outbox.md",
        text: "# 0004. Send share emails through an outbox\n\nDate: 2026-11-01\n\n## Status\n\nProposed.\n\n## Context\n\nA slow email provider mustn't hold up the basket API.\n\n## Decision\n\nAn outbox.\n\n## Alternatives considered\n\n- Calling the provider inline: too slow.\n",
      },
    ],
    changes: sharingFiles(),
    sourceFiles: [
      "src/basket-api/auth-middleware/index.ts",
      "src/basket-api/basket-controller/index.ts",
      "src/basket-api/basket-repository/index.ts",
      "src/basket-api/basket-service/index.ts",
      "src/basket-api/basket-sharing/index.ts",
      "src/basket-api/session-restore/index.ts",
    ],
    styles: elementStyles(fixture("sharing")),
    ...overrides,
  };
}

describe("the page for the sharing change", () => {
  const data = buildPageData(sharingInputs());

  it("marks what the PR adds and changes, but not a change to the requirements alone", () => {
    expect(data.changed).toBe(true);
    expect(data.elements.basketSharing?.mark).toBe("added");
    expect(data.elements.emailProvider?.mark).toBe("added");
    // basketController only gains #5 in its requirements.
    expect(data.elements.basketController?.mark).toBeUndefined();
    expect(data.relationships["basketSharing->emailOutbox"]?.mark).toBe("added");
    expect(data.elements.basketSharing?.inBefore).toBe(false);
  });

  it("lays every level out over what any mode can show", () => {
    expect(data.levels.map((level) => [level.id, level.title])).toEqual([
      ["context", "System context"],
      ["basket", "Containers of Basket"],
      ["basketApi", "Components of Basket API"],
    ]);
    const context = data.levels[0]!;
    expect(context.edges.find((edge) => edge.id === "basket->emailProvider")).toMatchObject({
      mark: "added",
      inBefore: false,
      inAfter: true,
      relationships: ["emailOutbox->emailProvider"],
    });
  });

  it("marks the edges as the PR comment does", () => {
    const components = data.levels.find((level) => level.id === "basketApi")!;
    expect(components.edges.find((edge) => edge.id === "basketController->basketSharing")?.mark).toBe("added");
    expect(components.edges.find((edge) => edge.id === "basketController->basketService")?.mark).toBeUndefined();
  });

  it("draws the drift on every level its ends are apart", () => {
    const components = data.levels.find((level) => level.id === "basketApi")!;
    expect(components.drift).toEqual([
      {
        id: "drift:basketController->basketRepository",
        source: "basketController",
        destination: "basketRepository",
        drift: ["basketController->basketRepository"],
      },
    ]);
    // Inside one container, so not on the levels above it.
    expect(data.levels[0]!.drift).toEqual([]);
    expect(data.drift["basketController->basketRepository"]?.through).toEqual(["basketService", "sessionRestore"]);
  });

  it("counts what's inside each element with a level of its own", () => {
    expect(data.elements.basketApi?.inside).toEqual({ added: 2, removed: 0, changed: 0, lines: 164, drifted: 1 });
    // Code outside the model isn't inside any element.
    expect(data.elements.basket?.inside).toEqual({ added: 2, removed: 0, changed: 0, lines: 164, drifted: 1 });
    expect(data.elements.basketSharing?.inside).toBeUndefined();
  });

  it("gives each tab its result from the checks it holds", () => {
    expect(data.tabs.target).toMatchObject({ counter: expect.stringMatching(/^\+\d+/), attention: false });
    expect(data.tabs.target.checks.map((each) => each.check)).toEqual(["valid", "target"]);
    expect(data.tabs.code).toMatchObject({ counter: "+206 −4", attention: false });
    expect(data.tabs.code.checks.map((each) => each.check)).toEqual(["surplus"]);
    expect(data.tabs.build).toMatchObject({ counter: "1 undeclared", attention: true });
    expect(data.tabs.build.checks.map((each) => each.check)).toEqual(["claim", "boundaries", "deployment"]);
    expect(data.tabs.behaviour).toMatchObject({ counter: "not checked", attention: false });
    expect(data.tabs.behaviour.checks.map((each) => each.check)).toEqual(["coverage", "paths"]);
  });

  it("reads each ADR's title and reason", () => {
    expect(data.target.adrs).toEqual([
      {
        path: "architecture/adrs/0004-share-emails-through-an-outbox.md",
        title: "0004. Send share emails through an outbox",
        reason: "A slow email provider mustn't hold up the basket API.",
        decision: "An outbox.",
        alternatives: "- Calling the provider inline: too slow.",
      },
    ]);
  });

  it("lists the views the PR adds first, drawn on their scope's level", () => {
    expect(data.views[0]).toMatchObject({ id: "req-5", issue: "#5", mark: "added", level: "basketApi" });
    expect(data.views.slice(1).every((view) => view.mark === undefined)).toBe(true);
  });

  it("gives the same data for the same inputs", () => {
    expect(JSON.stringify(buildPageData(sharingInputs()))).toBe(JSON.stringify(data));
  });
});

describe("code changes", () => {
  const data = buildPageData(sharingInputs());

  it("sums each component's files and lines up to its container and software system", () => {
    expect(data.elements.basketSharing?.code).toEqual({ files: 2, added: 150, removed: 0 });
    expect(data.elements.basketController?.code).toEqual({ files: 2, added: 10, removed: 4 });
    expect(data.elements.basketApi?.code).toEqual({ files: 4, added: 160, removed: 4 });
    expect(data.elements.basket?.code).toEqual({ files: 4, added: 160, removed: 4 });
    expect(data.elements.webApp?.code).toBeUndefined();
  });

  it("counts a binary file as a file with no lines", () => {
    expect(data.elements.basketController?.files).toEqual([
      { path: "src/basket-api/basket-controller/index.ts", added: 10, removed: 4 },
      { path: "src/basket-api/basket-controller/logo.png.ts", added: 0, removed: 0, binary: true },
    ]);
  });

  it("lists components and files most lines first", () => {
    expect(data.code.components).toEqual(["basketSharing", "basketController"]);
    expect(data.elements.basketSharing?.files?.map((file) => file.added)).toEqual([120, 30]);
  });

  it("counts code no component holds as outside the model", () => {
    expect(data.code.outside).toEqual([{ path: "src/basket-api/utils/email-template.ts", added: 46, removed: 0 }]);
    expect(data.code.total).toEqual({ files: 5, added: 206, removed: 4 });
  });

  it("takes what's outside the model from Surplus, when it ran", () => {
    const inputs = sharingInputs();
    inputs.check.checks[7] = {
      check: "surplus",
      status: "passed",
      blocking: false,
      outside: [],
      closed: [],
      untraced: [],
      traced: false,
    };
    expect(buildPageData(inputs).code.outside).toEqual([]);
  });

  it("says no change when the diff touches no functional code", () => {
    expect(buildPageData(sharingInputs({ changes: [] })).tabs.code.counter).toBe("no change");
  });

  it("parses git's numstat, binary files included", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\0-\t-\tsrc/logo.png\0")).toEqual([
      { path: "src/a.ts", added: 3, removed: 1 },
      { path: "src/logo.png", added: 0, removed: 0, binary: true },
    ]);
  });

  it("counts functional files only", () => {
    const config = { languages: [{ name: "typescript" as const, root: "." }] } as Parameters<typeof functionalFile>[0];
    expect(functionalFile(config, "src/basket-api/basket-sharing/index.ts")).toBe(true);
    for (const path of [
      "src/basket-api/basket-sharing/index.test.ts",
      "src/basket-api/basket-sharing/types.d.ts",
      "src/basket-api/basket-sharing/client.generated.ts",
      "src/generated/client.ts",
      "package-lock.json",
      "docs/sharing.md",
    ]) {
      expect(functionalFile(config, path), path).toBe(false);
    }
    expect(functionalFile(config, "src/a.ts", "// Code generated by protoc. DO NOT EDIT.\n")).toBe(false);
  });

  it("reads them from the branch's diff against the fork point", async () => {
    const root = basketRepo();
    const write = (path: string, text: string | Buffer) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    git(root, "checkout", "-q", "-b", "share");
    const service = join(root, "src/basket-api/basket-service/index.ts");
    writeFileSync(service, `${readFileSync(service, "utf8")}export const shared = true;\n`);
    write("src/basket-api/basket-sharing/index.ts", "export const share = () => {};\nexport const link = 1;\n");
    write("src/basket-api/basket-sharing/index.test.ts", "export {};\n");
    write("src/basket-api/basket-sharing/types.d.ts", "export {};\n");
    write("src/basket-api/basket-sharing/blob.ts", Buffer.from([0, 1, 2, 0]));
    write("docs/sharing.md", "# Sharing\n");
    git(root, "add", "src/basket-api/basket-service", "src/basket-api/basket-sharing/blob.ts");
    git(root, "commit", "-q", "-m", "share");
    const config = loadConfig(root);
    expect(await codeChanges(config, "main")).toEqual([
      { path: "src/basket-api/basket-service/index.ts", added: 1, removed: 0 },
      { path: "src/basket-api/basket-sharing/blob.ts", added: 0, removed: 0, binary: true },
      { path: "src/basket-api/basket-sharing/index.ts", added: 2, removed: 0 },
    ]);
  });
});

describe("built or not", () => {
  it("greys out a component whose path holds no code yet", () => {
    const data = buildPageData(sharingInputs());
    expect(data.elements.basketSharing?.built).toBe(true);
    expect(data.elements.emailOutbox?.built).toBe(false);
    // Elements with no path are drawn as usual.
    expect(data.elements.database?.built).toBeUndefined();
  });

  it("finds the repo's functional files", async () => {
    const root = basketRepo();
    const files = await sourceFiles(loadConfig(root));
    expect(files).toContain("src/basket-api/basket-service/index.ts");
    expect(files.some((file) => /\.test\.ts$/.test(file))).toBe(false);
  });
});

describe("kinds and shapes", () => {
  const container = (technology: string, tags: string[] = []): Element => ({
    id: "store",
    type: "container",
    name: "Store",
    description: "",
    technology,
    tags,
    requirements: [],
    properties: {},
  });
  const calledOver = (technology: string) => [
    {
      id: "a->store",
      source: "a",
      destination: "store",
      description: "Calls",
      technology,
      tags: [],
      requirements: [],
      properties: {},
    },
  ];
  const isStore = (id: string) => id === "store";

  it("takes the workspace's styles first, later ones winning", () => {
    const styles = [
      { tag: "Element", shape: "RoundedBox" },
      { tag: "Store", shape: "Folder" },
      { tag: "Store", shape: "Cylinder" },
    ];
    expect(appearance(container("Redis", ["Store"]), styles, [], isStore)).toEqual({
      kind: "Database",
      shape: "Cylinder",
      external: false,
    });
  });

  it("lets a style's shape win, and leaves the kind to the technology when the shape names none", () => {
    expect(appearance(container("Amazon SQS"), [{ tag: "Container", shape: "RoundedBox" }], [], isStore)).toEqual({
      kind: "Queue",
      shape: "RoundedBox",
      external: false,
    });
  });

  it("falls back to the technology", () => {
    const kind = (technology: string) => appearance(container(technology), [], [], isStore);
    expect(kind("PostgreSQL 16")).toMatchObject({ kind: "Database", shape: "Cylinder" });
    expect(kind("Apache Kafka")).toMatchObject({ kind: "Queue", shape: "Pipe" });
    expect(kind("TypeScript, React")).toMatchObject({ kind: "Web app", shape: "WebBrowser" });
    expect(kind("React Native")).toMatchObject({ kind: "Mobile app", shape: "MobileDevice" });
    expect(kind("Amazon S3")).toMatchObject({ kind: "File store", shape: "Folder" });
  });

  it("takes the technology over HTTP callers", () => {
    expect(appearance(container("PostgreSQL"), [], calledOver("JSON/HTTPS"), isStore).kind).toBe("Database");
  });

  it("calls a container that code outside it calls over HTTP an API, failing the rest", () => {
    expect(appearance(container("Node.js"), [], calledOver("JSON/HTTPS"), isStore)).toEqual({
      kind: "API",
      shape: "Box",
      external: false,
    });
    expect(appearance(container("Node.js"), [], calledOver("gRPC"), isStore).kind).toBe("API");
    expect(appearance(container("Node.js"), [], calledOver("SQL"), isStore).kind).toBe("Container");
  });

  it("marks external elements", () => {
    expect(appearance({ ...container(""), type: "softwareSystem", tags: ["External"] }, [], [], isStore)).toEqual({
      kind: "Software system",
      shape: "Box",
      external: true,
    });
  });

  it("draws the sharing fixture's database as its style says", () => {
    const data = buildPageData(sharingInputs());
    expect(data.elements.database).toMatchObject({ kind: "Database", shape: "Cylinder" });
    expect(data.elements.webApp).toMatchObject({ kind: "Web app", shape: "WebBrowser" });
    expect(data.elements.basketApi).toMatchObject({ kind: "API", shape: "Box" });
    expect(data.elements.shopper).toMatchObject({ kind: "Person", shape: "Person" });
  });
});

describe("modes", () => {
  const data = buildPageData(sharingInputs());
  const components = data.levels.find((level) => level.id === "basketApi")!;

  it("are Change, Before, After and Drift for a PR that changes the target", () => {
    expect(modesOf(data)).toEqual(["change", "before", "after", "drift"]);
  });

  it("are Target and Drift for one that doesn't", () => {
    const model = load("sharing");
    const same = buildPageData(sharingInputs({ target: model, forked: model, targetFiles: [] }));
    expect(same.changed).toBe(false);
    expect(modesOf(same)).toEqual(["target", "drift"]);
    expect(same.tabs.target.counter).toBe("no change");
    expect(same.elements.basketSharing?.mark).toBeUndefined();
  });

  it("show each side of the PR, and drift only in Drift", () => {
    const before = shown(data, components, "before");
    const after = shown(data, components, "after");
    const change = shown(data, components, "change");
    const drift = shown(data, components, "drift");
    expect(before.nodes.has("basketSharing")).toBe(false);
    expect(after.nodes.has("basketSharing")).toBe(true);
    expect(change.nodes.has("basketSharing")).toBe(true);
    expect(before.edges.has("basketController->basketSharing")).toBe(false);
    expect(after.edges.has("basketController->basketSharing")).toBe(true);
    for (const mode of [before, after, change]) {
      expect(mode.edges.has("drift:basketController->basketRepository")).toBe(false);
    }
    expect(drift.edges.has("drift:basketController->basketRepository")).toBe(true);
    expect(drift.nodes).toEqual(after.nodes);
  });

  it("show what a PR removes in Before and Change only", () => {
    const removed = buildPageData(sharingInputs({ target: load("initial"), forked: load("sharing") }));
    const level = removed.levels.find((each) => each.id === "basketApi")!;
    expect(removed.elements.basketSharing?.mark).toBe("removed");
    expect(shown(removed, level, "before").nodes.has("basketSharing")).toBe(true);
    expect(shown(removed, level, "change").nodes.has("basketSharing")).toBe(true);
    expect(shown(removed, level, "after").nodes.has("basketSharing")).toBe(false);
  });
});

describe("a changed dynamic view", () => {
  it("comes first, with its steps before the PR", () => {
    const before = load("initial");
    const after: Model = load("initial");
    after.dynamicViews.get("req-2")!.steps = after.dynamicViews.get("req-2")!.steps.slice(0, 2);
    const data = buildPageData(sharingInputs({ target: after, forked: before }));
    expect(data.views[0]).toMatchObject({ id: "req-2", mark: "changed" });
    expect(data.views[0]?.steps).toHaveLength(2);
    expect(data.views[0]?.before?.length).toBeGreaterThan(2);
    expect(data.views[0]?.steps[0]).toMatchObject({ from: expect.any(String), to: expect.any(String) });
  });
});

describe("a view's trace", () => {
  // #2 checks only its steps between components: 2, 4 and 6. The test stops after step 4.
  const inputs = sharingInputs();
  const step = (source: string, destination: string) => ({ source, destination, description: "" });
  const call = (source: string, destination: string) => ({ source, destination, functions: ["f"] });
  inputs.check.checks[6] = {
    check: "paths",
    status: "failed",
    blocking: true,
    issues: ["#2"],
    views: [
      {
        issue: "#2",
        view: "req-2",
        description: "#2 Add an item to the basket",
        status: "failed",
        components: [],
        expected: [
          step("basketController", "authMiddleware"),
          step("basketController", "basketService"),
          step("basketService", "basketRepository"),
        ],
        tests: [
          {
            name: "#2/AC1 adds an item",
            criterion: "#2/AC1",
            status: "unmatched",
            observed: [
              call("basketController", "authMiddleware"),
              call("basketController", "basketService"),
              call("basketService", "sessionRestore"),
            ],
            steps: [0, 1, null],
            undeclared: [2],
            offTarget: [],
          },
        ],
        uncovered: [2],
      },
    ],
  };
  const view = buildPageData(inputs).views.find((each) => each.id === "req-2")!;

  it("says which of the view's steps it checks", () => {
    expect(view.trace?.checked).toEqual([false, true, false, true, false, true, false]);
  });

  it("says how far each test took the view, and the steps no test takes", () => {
    expect(view.trace?.tests[0]).toMatchObject({
      took: [false, true, false, true, false, false, false],
      reached: 4,
      offPath: [{ source: "basketService", destination: "sessionRestore", functions: ["f"], offTarget: false }],
    });
    expect(view.trace?.untested).toEqual([5]);
  });

  it("counts them on the Behaviour tab", () => {
    expect(buildPageData(inputs).tabs.behaviour).toMatchObject({ counter: "1 off path", attention: true });
  });
});

describe("the page for a basket branch, from the real checks", () => {
  const issuesFile = join(basketDir, "issues.json");
  beforeEach(() => vi.stubEnv("BEARING_ISSUES_FILE", issuesFile));
  afterEach(() => vi.unstubAllEnvs());

  it("finds the undeclared import, the trace and the code changes, the same way twice", async () => {
    const root = variantRepo("controller-imports-repository");
    const config = loadConfig(root);
    const check = await runChecks(config, { base: "main" });
    const gathered = await gatherReport(config, "main");
    const build = async () =>
      buildPageData({
        check,
        ...gathered,
        changes: await codeChanges(config, "main"),
        sourceFiles: await sourceFiles(config),
        styles: elementStyles(JSON.parse(readFileSync(join(root, "architecture", "workspace.json"), "utf8"))),
      });
    const data = await build();
    expect(data.changed).toBe(false);
    expect(data.tabs.build).toMatchObject({ counter: "1 undeclared", attention: true });
    expect(data.drift["basketController->basketRepository"]?.imports[0]).toMatchObject({
      file: "src/basket-api/basket-controller/index.ts",
    });
    expect(data.build.claim.status).toBe("failed");
    expect(data.code.components).toEqual(["basketController"]);
    expect(data.elements.basketApi?.inside?.drifted).toBe(1);
    const view = data.views.find((each) => each.id === "req-2")!;
    expect(view.trace?.status).toBe("passed");
    // Each test takes every step Trace paths checks: those between components, not the web app's call into the API.
    expect(view.trace?.checked).toContain(false);
    for (const test of view.trace?.tests ?? []) {
      expect(test.took).toEqual(view.trace?.checked);
      expect(test.reached).toBe(view.trace!.checked.lastIndexOf(true) + 1);
    }
    expect(view.trace?.untested).toEqual([]);
    expect(view.criteria?.map((each) => each.status)).toEqual(["covered", "covered"]);
    expect(data.tabs.behaviour.counter).toBe("covered");
    expect(JSON.stringify(await build())).toBe(JSON.stringify(data));
  });
});
