import type { Config } from "./config.js";
import { dynamicViewKey, type Model } from "./model.js";
import { componentPaths } from "./paths.js";
import type { Requirement } from "./requirements.js";
import type { SpanRecord } from "./test.js";
import { criterionTag, type TestRecord } from "./trace/runtime.js";

// Trace paths: each passing test tagged with a criterion of a touched issue must take that issue's dynamic view.
// See the Checks section of docs/product-spec.md.
//
// A test can only observe calls between components, since only components' code is traced. So the path a view
// expects is its steps between two components; steps to people, containers and external systems are dropped, and
// so is the step into the system, which the test itself stands in for. The path a test takes is each call into a
// component from a different one, in the order the calls started. Consecutive calls between the same two
// components count as one step, in both.
//
// A view matches when its steps appear in order in the observed path with no call into an undeclared component in
// between. Each step matches its earliest occurrence after the step before, as a plain subsequence test does. That
// matters because a test's setup and its read-back often run another issue's path: #2's tests read the basket back
// along #1's path, which has the same steps between components as #2's. Letting the match start at a later call
// would let that read-back stand in for the add.

// A step of a view, between two components.
export interface PathStep {
  source: string;
  destination: string;
  description: string;
}

// A call, or consecutive calls, from one component into another. A call with no source came from the test.
export interface ObservedCall {
  source?: string;
  destination: string;
  // The functions called, in order, without repeats.
  functions: string[];
}

export interface TestPath {
  // The test's full name and its file.
  name: string;
  file?: string;
  criterion: string;
  status: "matched" | "unmatched";
  observed: ObservedCall[];
  // For each expected step, the index in `observed` of the call it matched, or null if it wasn't found.
  steps: Array<number | null>;
  // Indexes in `observed` of calls into or out of components the view doesn't declare, between the first matched
  // step and the last, or the end of the trace if a step is missing.
  undeclared: number[];
}

export interface ViewPaths {
  // "#2"
  issue: string;
  // "req-2"
  view: string;
  // The view's title, e.g. "#2 Add an item to the basket".
  description: string;
  status: "passed" | "failed" | "skipped";
  // Why the view was skipped or failed without a test to show.
  reason?: string;
  // Every element the view's steps name, components or not.
  components: string[];
  expected: PathStep[];
  tests: TestPath[];
}

// Checks the passing tagged tests of each issue against its dynamic view, in issue order.
export function checkTracePaths(
  config: Config,
  inputs: { target: Model; requirements: Requirement[]; issues: number[]; tests: TestRecord[]; spans: SpanRecord[] },
): ViewPaths[] {
  const { target, requirements, issues, tests, spans } = inputs;
  const traced = new Set(componentPaths(target).map((component) => component.id));
  const byNumber = new Map(requirements.map((requirement) => [requirement.number, requirement]));
  // Each test's traces by ID. A test has one trace per process that ran it, so usually one.
  const traces = new Map<string, Map<string, SpanRecord[]>>();
  for (const span of spans) {
    if (span.test === undefined) continue;
    const byId = traces.get(span.test) ?? new Map<string, SpanRecord[]>();
    traces.set(span.test, byId);
    const trace = byId.get(span.traceId) ?? [];
    byId.set(span.traceId, trace);
    trace.push(span);
  }

  return [...new Set(issues)]
    .sort((a, b) => a - b)
    .flatMap((issue): ViewPaths[] => {
      const requirement = byNumber.get(issue);
      if (requirement === undefined || requirement.epic) return [];
      const key = dynamicViewKey(issue);
      const view = target.dynamicViews.get(key);
      const components = [...new Set(view?.steps.flatMap((step) => [step.source, step.destination]) ?? [])];
      const base = {
        issue: `#${issue}`,
        view: key,
        description: view?.description ?? "",
        components,
        expected: [],
        tests: [],
      };
      if (view === undefined) {
        return [
          { ...base, status: "failed", reason: `the target has no dynamic view "${key}"; run \`bearing validate\`` },
        ];
      }
      const expected = mergeSteps(
        view.steps
          .filter((step) => traced.has(step.source) && traced.has(step.destination))
          .map(({ source, destination, description }) => ({ source, destination, description })),
      );
      if (expected.length === 0) {
        return [{ ...base, status: "skipped", reason: "none of its steps runs between two components" }];
      }
      const tags = new Set(
        requirement.criteria.map((criterion) => criterionTag(config.tests.tag, issue, criterion.number)),
      );
      const passing = new Map<string, TestRecord>();
      for (const test of tests) {
        if (test.status === "passed" && test.criterion !== undefined && tags.has(test.criterion)) {
          passing.set(test.name, test);
        }
      }
      if (passing.size === 0) {
        return [{ ...base, expected, status: "skipped", reason: "no passing test is tagged with its criteria" }];
      }
      const declared = new Set(components);
      const paths = [...passing.values()].flatMap((test) => {
        // A passing test with no spans took none of the path.
        const found = [...(traces.get(test.name)?.values() ?? [])];
        return (found.length === 0 ? [[]] : found).map((trace) => {
          const observed = observedPath(trace);
          const match = matchPath(expected, observed, declared);
          const path: TestPath = {
            name: test.name,
            criterion: test.criterion!,
            status: match.steps.includes(null) || match.undeclared.length > 0 ? "unmatched" : "matched",
            observed,
            ...match,
          };
          if (test.file !== undefined) path.file = test.file;
          return path;
        });
      });
      const failed = paths.some((path) => path.status === "unmatched");
      return [{ ...base, expected, tests: paths, status: failed ? "failed" : "passed" }];
    });
}

// The calls one test's spans make between components, in the order they started.
export function observedPath(spans: SpanRecord[]): ObservedCall[] {
  // Span IDs count up within a process, so they order calls that started in the same nanosecond.
  const sorted = [...spans].sort((a, b) =>
    a.start === b.start ? a.spanId.localeCompare(b.spanId) : a.start < b.start ? -1 : 1,
  );
  const byId = new Map(sorted.map((span) => [span.spanId, span]));
  const calls: ObservedCall[] = [];
  for (const span of sorted) {
    const source = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId)?.component;
    if (source === span.component) continue;
    const last = calls.at(-1);
    if (last !== undefined && last.source === source && last.destination === span.component && source !== undefined) {
      if (!last.functions.includes(span.name)) last.functions.push(span.name);
    } else {
      calls.push(
        source === undefined
          ? { destination: span.component, functions: [span.name] }
          : { source, destination: span.component, functions: [span.name] },
      );
    }
  }
  return calls;
}

// Matches each expected step to its earliest occurrence after the step before, stopping at the first that isn't
// found, then finds the calls between the first match and the last that involve a component the view doesn't
// declare.
export function matchPath(
  expected: PathStep[],
  observed: ObservedCall[],
  declared: Set<string>,
): Pick<TestPath, "steps" | "undeclared"> {
  const steps: Array<number | null> = [];
  let from = 0;
  for (const step of expected) {
    const index = observed.findIndex(
      (call, at) => at >= from && call.source === step.source && call.destination === step.destination,
    );
    // Once a step is missing, the order is broken, so the rest count as missing too.
    steps.push(index === -1 ? null : index);
    from = index === -1 ? Infinity : index + 1;
  }
  const matched = steps.filter((index) => index !== null);
  const undeclared: number[] = [];
  if (matched.length > 0) {
    // A path with a step missing never got to its end, so everything after its first step counts as in between.
    const last = steps.includes(null) ? observed.length - 1 : matched.at(-1)!;
    for (let index = matched[0]!; index <= last; index++) {
      const call = observed[index]!;
      const outside = (component: string | undefined) => component !== undefined && !declared.has(component);
      if (outside(call.source) || outside(call.destination)) undeclared.push(index);
    }
  }
  return { steps, undeclared };
}

function mergeSteps(steps: PathStep[]): PathStep[] {
  const merged: PathStep[] = [];
  for (const step of steps) {
    const last = merged.at(-1);
    if (last?.source === step.source && last.destination === step.destination) {
      last.description = `${last.description}, ${step.description}`;
    } else {
      merged.push({ ...step });
    }
  }
  return merged;
}

export function formatTracePaths(views: ViewPaths[]): string {
  const tests = views.flatMap((view) => view.tests);
  const unmatched = tests.filter((test) => test.status === "unmatched").length;
  const failed = views.some((view) => view.status === "failed");
  const counted = (count: number) => (count === 1 ? "1 tagged test" : `${count} tagged tests`);
  let header: string;
  if (failed && unmatched > 0) {
    header = `Trace paths: failed, ${unmatched} of ${counted(tests.length)} ${unmatched === 1 ? "doesn't follow its" : "don't follow their"} issue's dynamic view`;
  } else if (failed) {
    header = "Trace paths: failed";
  } else {
    header = `Trace paths: passed, ${tests.length === 1 ? "the 1 tagged test follows its" : `all ${counted(tests.length)} follow their`} issue's dynamic view`;
  }
  const lines = [header];
  for (const view of views) {
    if (view.reason !== undefined) {
      lines.push(`  ${view.issue}: ${view.status}, ${view.reason}`);
      continue;
    }
    for (const test of view.tests.filter((each) => each.status === "unmatched")) {
      lines.push(`  ${test.name}${test.file === undefined ? "" : ` (${test.file})`}`, ...sideBySide(view, test));
    }
  }
  if (unmatched > 0) {
    lines.push("  Move the code into the components each view declares, or propose a change to the view in the model.");
  }
  return `${lines.join("\n")}\n`;
}

// The expected path beside the observed one, each step on the row of the call it matched.
function sideBySide(view: ViewPaths, test: TestPath): string[] {
  const rows: Array<[string, string]> = [[`Expected (${view.view})`, "Observed"]];
  const byCall = new Map(test.steps.flatMap((call, step) => (call === null ? [] : [[call, step]])));
  const undeclared = new Set(test.undeclared);
  test.observed.forEach((call, index) => {
    const step = byCall.get(index);
    let observed = `${call.source ?? "(test)"} -> ${call.destination}: ${call.functions.map((name) => `${name}()`).join(", ")}`;
    if (undeclared.has(index)) {
      const outside = [call.source, call.destination].filter(
        (component) => component !== undefined && !view.components.includes(component),
      );
      observed += `  <- ${outside.join(" and ")} ${outside.length === 1 ? "isn't" : "aren't"} in ${view.view}`;
    }
    rows.push([step === undefined ? "" : pair(view.expected[step]!), observed]);
  });
  test.steps.forEach((call, step) => {
    if (call === null) rows.push([pair(view.expected[step]!), "missing"]);
  });
  const width = Math.max(...rows.map(([expected]) => expected.length));
  return rows.map(([expected, observed]) => `    ${expected.padEnd(width)}  ${observed}`.trimEnd());
}

function pair(step: PathStep): string {
  return `${step.source} -> ${step.destination}`;
}
