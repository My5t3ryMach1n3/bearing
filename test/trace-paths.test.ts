import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { modelFromWorkspace, type Model } from "../src/model.js";
import { loadRequirements } from "../src/requirements.js";
import type { SpanRecord } from "../src/test.js";
import { checkTracePaths, matchPath, observedPath, type PathStep } from "../src/trace-paths.js";
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
    const record: SpanRecord = { traceId: test, spanId, name, component, start: BigInt(records.length), test };
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

const step = (source: string, destination: string): PathStep => ({ source, destination, description: "" });
const pairs = (path: Array<{ source?: string; destination: string }>) =>
  path.map((call) => `${call.source ?? "(test)"}->${call.destination}`);

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
    expect(matchPath(expected, observed, declared).steps).toEqual([3, null, null]);
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
