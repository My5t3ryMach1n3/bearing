import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { modelFromWorkspace, type Model } from "../src/model.js";
import { loadRequirements } from "../src/requirements.js";
import type { SpanRecord } from "../src/test.js";
import { checkTracePaths, formatTracePaths, matchPath, observedPath, type PathStep } from "../src/trace-paths.js";
import type { TestRecord } from "../src/trace/runtime.js";
import { basketDir } from "./basket.js";

const config = loadConfig(join(basketDir, "repo"));
const requirements = await loadRequirements(config, { issuesFile: join(basketDir, "issues.json") });
const target = modelFromWorkspace(JSON.parse(readFileSync(join(basketDir, "workspace.json"), "utf8")));

// A call into a component, "<component>.<function>", with the calls it makes.
type Call = [string, ...Call[]];

// The spans a test's calls leave, one trace per test, each call starting after the one before.
function spans(test: string, ...calls: Call[]): SpanRecord[] {
  const records: SpanRecord[] = [];
  const add = ([call, ...children]: Call, parentSpanId?: string) => {
    const [component, name] = call.split(".") as [string, string];
    const spanId = String(records.length).padStart(16, "0");
    const record: SpanRecord = {
      traceId: test,
      spanId,
      name,
      component,
      file: `${component}.ts`,
      start: BigInt(records.length),
      test,
    };
    if (parentSpanId !== undefined) record.parentSpanId = parentSpanId;
    records.push(record);
    for (const child of children) add(child, spanId);
  };
  for (const call of calls) add(call);
  return records;
}

const passed = (name: string, criterion: string): TestRecord => ({ name, status: "passed", criterion });

const addItem: Call = [
  "basketController.handle",
  ["authMiddleware.authenticate"],
  [
    "basketService.addItem",
    ["basketService.isValidQuantity"],
    ["basketRepository.loadBasket"],
    ["basketRepository.saveBasket"],
  ],
];
const getBasket: Call = [
  "basketController.handle",
  ["authMiddleware.authenticate"],
  ["basketService.getBasket", ["basketRepository.loadBasket"]],
];
const restore: Call = [
  "basketController.handle",
  ["sessionRestore.restoreSession", ["authMiddleware.authenticate"], ["basketRepository.loadBasket"]],
];

const addRepository: Call = ["basketRepository.saveBasket"];

const step = (source: string, destination: string): PathStep => ({ source, destination, description: "" });
const pairs = (path: Array<{ source?: string; destination: string }>) =>
  path.map((call) => `${call.source ?? "(test)"}->${call.destination}`);

// controller-imports-repository's add, which skips the service, then a read-back along #1's path.
const addItemSkippingService: Call = [
  "basketController.handle",
  ["authMiddleware.authenticate"],
  ["basketRepository.saveBasket"],
];

describe("observedPath", () => {
  it("lists calls between components in the order they started, skipping calls within one", () => {
    expect(observedPath(spans("t", addItem, getBasket))).toEqual([
      { destination: "basketController", functions: ["handle"] },
      { source: "basketController", destination: "authMiddleware", functions: ["authenticate"] },
      { source: "basketController", destination: "basketService", functions: ["addItem"] },
      { source: "basketService", destination: "basketRepository", functions: ["loadBasket", "saveBasket"] },
      { destination: "basketController", functions: ["handle"] },
      { source: "basketController", destination: "authMiddleware", functions: ["authenticate"] },
      { source: "basketController", destination: "basketService", functions: ["getBasket"] },
      { source: "basketService", destination: "basketRepository", functions: ["loadBasket"] },
    ]);
  });

  it("orders by start time, not the order spans were written in", () => {
    const written = spans("t", getBasket).reverse();
    expect(pairs(observedPath(written))).toEqual([
      "(test)->basketController",
      "basketController->authMiddleware",
      "basketController->basketService",
      "basketService->basketRepository",
    ]);
  });
});

describe("matchPath", () => {
  const expected = [
    step("basketController", "authMiddleware"),
    step("basketController", "basketService"),
    step("basketService", "basketRepository"),
  ];
  const declared = new Set(["webApp", "basketController", "authMiddleware", "basketService", "basketRepository"]);

  it("matches the steps in order, with calls before and after them", () => {
    const observed = observedPath(spans("t", restore, addItem, getBasket));
    expect(matchPath(expected, observed, declared)).toEqual({ steps: [5, 6, 7], undeclared: [] });
  });

  it("allows calls between declared components in between", () => {
    const observed = observedPath(
      spans("t", [
        "basketController.handle",
        ["authMiddleware.authenticate"],
        ["basketService.addItem", ["authMiddleware.authenticate"], ["basketRepository.loadBasket"]],
      ]),
    );
    expect(matchPath(expected, observed, declared)).toEqual({ steps: [1, 2, 4], undeclared: [] });
  });

  it("finds a call into an undeclared component in between", () => {
    const observed = observedPath(
      spans("t", [
        "basketController.handle",
        ["authMiddleware.authenticate"],
        ["sessionRestore.addItem"],
        ["basketService.addItem", ["basketRepository.saveBasket"]],
      ]),
    );
    expect(matchPath(expected, observed, declared)).toEqual({ steps: [1, 3, 4], undeclared: [2] });
  });

  it("matches each step at its earliest occurrence, so a later request can't stand in for an earlier one", () => {
    const misplaced: Call = [
      "basketController.handle",
      ["authMiddleware.authenticate"],
      ["sessionRestore.addItem", ["basketRepository.saveBasket"]],
    ];
    const observed = observedPath(spans("t", misplaced, getBasket));
    expect(matchPath(expected, observed, declared)).toEqual({ steps: [1, 6, 7], undeclared: [2, 3] });
  });

  it("marks the rest missing once a step isn't found, and checks to the end of the trace", () => {
    const observed = observedPath(
      spans("t", [
        "basketController.handle",
        ["authMiddleware.authenticate"],
        ["sessionRestore.addItem", ["basketRepository.saveBasket"]],
      ]),
    );
    expect(matchPath(expected, observed, declared)).toEqual({ steps: [1, null, null], undeclared: [2, 3] });
  });

  it("doesn't match steps out of order", () => {
    const observed = observedPath(
      spans("t", [
        "basketController.handle",
        ["basketService.getBasket", ["basketRepository.loadBasket"]],
        ["authMiddleware.authenticate"],
      ]),
    );
    expect(matchPath(expected, observed, declared).steps).toEqual([null, 1, 2]);
  });

  it("takes the longest unbroken run, wherever it starts in the view", () => {
    const observed = observedPath(spans("t", ["basketController.handle", ["basketService.addItem", addRepository]]));
    expect(matchPath(expected, observed, declared)).toEqual({ steps: [null, 1, 2], undeclared: [] });
  });

  it("doesn't join steps with a gap between them into one run", () => {
    const observed = observedPath(
      spans(
        "t",
        ["basketController.handle", ["authMiddleware.authenticate"]],
        ["basketService.addItem", addRepository],
      ),
    );
    expect(matchPath(expected, observed, declared).steps).toEqual([1, null, null]);
  });

  it("matches none of a path that takes no step", () => {
    const observed = observedPath(spans("t", ["basketController.handle"]));
    expect(matchPath(expected, observed, declared).steps).toEqual([null, null, null]);
  });
});

describe("a story whose criteria take different paths through its view", () => {
  const req2 = target.dynamicViews.get("req-2")!;
  const req4 = target.dynamicViews.get("req-4")!;
  const model: Model = {
    ...target,
    dynamicViews: new Map([["req-2", { ...req2, steps: [...req2.steps, ...req4.steps] }]]),
  };
  const check = (tests: TestRecord[], records: SpanRecord[]) =>
    checkTracePaths(config, { target: model, requirements, issues: [2], tests, spans: records })[0]!;
  const tests = [passed("a", "#2/AC1"), passed("b", "#2/AC2")];

  it("passes when each test takes its part and together they take the whole view", () => {
    const view = check(tests, [...spans("a", addItem), ...spans("b", restore)]);
    expect(view).toMatchObject({ status: "passed", uncovered: [] });
    expect(view.tests.map((test) => test.status)).toEqual(["matched", "matched"]);
    expect(view.tests[0]!.steps.slice(3).every((call) => call === null)).toBe(true);
    expect(view.tests[1]!.steps.slice(0, 3).every((call) => call === null)).toBe(true);
  });

  it("fails on the steps no test takes, though every test matched", () => {
    const view = check(tests, [...spans("a", addItem), ...spans("b", addItem)]);
    expect(view.status).toBe("failed");
    expect(view.tests.map((test) => test.status)).toEqual(["matched", "matched"]);
    expect(view.uncovered.map((step) => view.expected[step]!.destination)).toEqual([
      "sessionRestore",
      "authMiddleware",
      "basketRepository",
    ]);
    const printed = formatTracePaths([view]);
    expect(printed).toContain("#2: no tagged test takes basketController -> sessionRestore in req-2");
    expect(printed).toContain("propose a change to the view");
  });

  it("keeps the advice when another view failed with a reason", () => {
    const view = check(tests, [...spans("a", addItem), ...spans("b", addItem)]);
    const noView = { ...view, issue: "#9", status: "failed" as const, reason: "no view", tests: [], uncovered: [] };
    expect(formatTracePaths([noView, view])).toContain("propose a change to the view");
  });

  it("doesn't call a step missing from one test when another takes it", () => {
    const strayed: Call = ["basketController.handle", ["authMiddleware.authenticate"], ["catalogue.lookUp"]];
    const view = check(tests, [...spans("a", strayed), ...spans("b", addItem, restore)]);
    expect(view.status).toBe("failed");
    expect(view.tests[0]).toMatchObject({ status: "unmatched", undeclared: [2] });
    expect(formatTracePaths([view])).not.toContain("missing");
  });
});

describe("checkTracePaths", () => {
  const check = (tests: TestRecord[], records: SpanRecord[], issues = [2], model: Model = target) =>
    checkTracePaths(config, { target: model, requirements, issues, tests, spans: records });

  it("expects only the view's steps between components, merging repeats", () => {
    const [view] = check([passed("a", "#2/AC1")], spans("a", addItem));
    expect(pairs(view!.expected)).toEqual([
      "basketController->authMiddleware",
      "basketController->basketService",
      "basketService->basketRepository",
    ]);
    expect(view).toMatchObject({ issue: "#2", view: "req-2", status: "passed", tests: [{ status: "matched" }] });
  });

  it("fails a shortcut the target doesn't declare, though a read-back still takes the view's steps", () => {
    const [view] = check([passed("a", "#2/AC1")], spans("a", addItemSkippingService, getBasket));
    expect(view).toMatchObject({ status: "failed", tests: [{ status: "unmatched", offTarget: [2] }] });
    const [test] = view!.tests;
    expect(test!.steps).not.toContain(null);
    expect(test!.observed[2]).toMatchObject({ source: "basketController", destination: "basketRepository" });
    expect(formatTracePaths([view!])).toContain("<- the target declares no relationship for this call");
  });

  it("passes a call the target declares but the view doesn't draw", () => {
    const [view] = check([passed("a", "#2/AC1")], spans("a", restore, addItem));
    expect(view!.tests[0]!.offTarget).toEqual([]);
  });

  it("checks every passing tagged test of the issue, and only those", () => {
    const tests = [
      passed("a", "#2/AC1"),
      passed("b", "#2/AC2"),
      { ...passed("c", "#2/AC2"), status: "failed" as const },
      passed("d", "#4/AC1"),
      { name: "untagged", status: "passed" as const },
    ];
    const records = ["a", "b", "c", "d", "untagged"].flatMap((name) => spans(name, addItem));
    expect(check(tests, records)[0]!.tests.map((test) => test.name)).toEqual(["a", "b"]);
  });

  it("fails a passing tagged test that left no spans", () => {
    const [view] = check([passed("a", "#2/AC1")], []);
    expect(view).toMatchObject({
      status: "failed",
      tests: [{ status: "unmatched", observed: [], steps: [null, null, null] }],
    });
  });

  it("skips an issue with no passing tagged test, since coverage fails it", () => {
    expect(check([], [])).toEqual([
      expect.objectContaining({ status: "skipped", reason: expect.stringContaining("no passing test") }),
    ]);
  });

  it("passes #4, whose setup adds an item before its first step", () => {
    const [view] = check([passed("a", "#4/AC1")], spans("a", addItem, restore), [4]);
    expect(view).toMatchObject({ status: "passed" });
  });

  it("fails an issue whose dynamic view is missing", () => {
    const model = { ...target, dynamicViews: new Map([...target.dynamicViews].filter(([key]) => key !== "req-2")) };
    expect(check([passed("a", "#2/AC1")], spans("a", addItem), [2], model)).toEqual([
      expect.objectContaining({ status: "failed", reason: expect.stringContaining('no dynamic view "req-2"') }),
    ]);
  });

  it("skips a view with no steps between components", () => {
    const view = target.dynamicViews.get("req-2")!;
    const model = {
      ...target,
      dynamicViews: new Map([["req-2", { ...view, steps: view.steps.filter((each) => each.source === "webApp") }]]),
    };
    expect(check([passed("a", "#2/AC1")], spans("a", addItem), [2], model)).toEqual([
      expect.objectContaining({ status: "skipped", reason: expect.stringContaining("between two components") }),
    ]);
  });
});
