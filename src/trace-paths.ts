import type { Config } from "./config.js";
import { dynamicViewKey, type Model } from "./model.js";
import { componentPaths } from "./paths.js";
import type { Requirement } from "./requirements.js";
import type { SpanRecord } from "./test.js";
import { criterionTag, type TestRecord } from "./trace/runtime.js";

// Trace paths: each passing test tagged with a criterion of a touched issue must follow part of that issue's dynamic
// view, and together a story's tests must take all of it. See the Checks section of docs/product-spec.md.
//
// A test can only observe calls between components, since only components' code is traced. So the path a view
// expects is its steps between two components; steps to people, containers and external systems are dropped, and
// so is the step into the system, which the test itself stands in for. The path a test takes is each call into a
// component from a different one, in the order the calls started. Consecutive calls between the same two
// components count as one step, in both.
//
// A story has one view, but its criteria can take different parts of it, so a test matches the longest unbroken run of
// the view's steps it takes, earliest in the view on a tie, with no call into an undeclared component in between. A run
// that stops short of the view's end is checked for those calls to the end of the trace, since it never got to its
// end. Any step that no test's run takes fails the view.
//
// Each step matches its earliest occurrence after the step before, as a plain subsequence test does. That matters
// because a test's setup and its read-back often run another issue's path: #2's tests read the basket back along #1's
// path, which has the same steps between components as #2's. Letting the match start at a later call would let that
// read-back stand in for the add.
//
// A test also fails on a call anywhere in its trace between two components the target declares no relationship
// between. A read-back can't hide such a shortcut, and tracing sees one that imports can't, such as through a port
// the caller is handed. A call the target declares but the view doesn't draw is fine, as setup and read-back run them.

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
  // For each expected step, the index in `observed` of the call it matched, or null if it's not in the test's run.
  steps: Array<number | null>;
  // Indexes in `observed` of calls into or out of components the view doesn't declare, between the first matched
  // step and the last, or the end of the trace if the run stops short of the view.
  undeclared: number[];
  // Indexes in `observed` of calls anywhere in the trace between two components the target has no relationship for.
  offTarget: number[];
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
  // Indexes in `expected` of the steps no test's run took.
  uncovered: number[];
}

// Checks the passing tagged tests of each issue against its dynamic view, in issue order.
export function checkTracePaths(
  config: Config,
  inputs: { target: Model; requirements: Requirement[]; issues: number[]; tests: TestRecord[]; spans: SpanRecord[] },
): ViewPaths[] {
  const { target, requirements, issues, tests, spans } = inputs;
  const traced = new Set(componentPaths(target).map((component) => component.id));
  const declaredCalls = new Set([...target.relationships.values()].map(callKey));
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
        uncovered: [],
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
          const offTarget = offTargetCalls(observed, declaredCalls);
          const path: TestPath = {
            name: test.name,
            criterion: test.criterion!,
            status:
              match.steps.every((call) => call === null) || match.undeclared.length > 0 || offTarget.length > 0
                ? "unmatched"
                : "matched",
            observed,
            ...match,
            offTarget,
          };
          if (test.file !== undefined) path.file = test.file;
          return path;
        });
      });
      const uncovered = expected.flatMap((_, step) => (paths.some((path) => path.steps[step] !== null) ? [] : [step]));
      const failed = uncovered.length > 0 || paths.some((path) => path.status === "unmatched");
      return [{ ...base, expected, tests: paths, uncovered, status: failed ? "failed" : "passed" }];
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

// Finds the longest unbroken run of expected steps in the observed path, earliest in the view on a tie, then the calls
// between its first match and its last that involve a component the view doesn't declare.
export function matchPath(
  expected: PathStep[],
  observed: ObservedCall[],
  declared: Set<string>,
): Pick<TestPath, "steps" | "undeclared"> {
  const taken = (run: Array<number | null>) => run.filter((index) => index !== null).length;
  let steps: Array<number | null> = expected.map(() => null);
  for (let start = 0; start < expected.length; start++) {
    const run = matchRun(expected, observed, start);
    if (taken(run) > taken(steps)) steps = run;
  }
  const matched = steps.filter((index) => index !== null);
  const undeclared: number[] = [];
  if (matched.length > 0) {
    // A run that stops short never got to the view's end, so everything after its first step counts as in between.
    const last = steps.includes(null) ? observed.length - 1 : matched.at(-1)!;
    for (let index = matched[0]!; index <= last; index++) {
      const call = observed[index]!;
      const outside = (component: string | undefined) => component !== undefined && !declared.has(component);
      if (outside(call.source) || outside(call.destination)) undeclared.push(index);
    }
  }
  return { steps, undeclared };
}

// Matches each step from `start` to its earliest occurrence after the step before, stopping at the first that isn't
// found. Steps outside the run are null.
function matchRun(expected: PathStep[], observed: ObservedCall[], start: number): Array<number | null> {
  const steps: Array<number | null> = [];
  let from = 0;
  for (const [position, step] of expected.entries()) {
    if (position < start) {
      steps.push(null);
      continue;
    }
    const index = observed.findIndex(
      (call, at) => at >= from && call.source === step.source && call.destination === step.destination,
    );
    // Once a step is missing, the run is broken, so the rest are outside it too.
    steps.push(index === -1 ? null : index);
    from = index === -1 ? Infinity : index + 1;
  }
  return steps;
}

const callKey = (call: { source?: string; destination: string }) => `${call.source}->${call.destination}`;

// The indexes of calls between two components that the target has no relationship for. A call from the test has no
// source, so it's never one.
export function offTargetCalls(observed: ObservedCall[], declared: Set<string>): number[] {
  return observed.flatMap((call, index) => (call.source === undefined || declared.has(callKey(call)) ? [] : [index]));
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
    for (const step of view.uncovered) {
      lines.push(`  ${view.issue}: no tagged test takes ${pair(view.expected[step]!)} in ${view.view}`);
    }
  }
  if (unmatched > 0 || views.some((view) => view.uncovered.length > 0)) {
    lines.push("  Move the code into the components each view declares, or propose a change to the view in the model.");
  }
  return `${lines.join("\n")}\n`;
}

// The expected path beside the observed one, each step on the row of the call it matched.
function sideBySide(view: ViewPaths, test: TestPath): string[] {
  const rows: Array<[string, string]> = [[`Expected (${view.view})`, "Observed"]];
  const byCall = new Map(test.steps.flatMap((call, step) => (call === null ? [] : [[call, step]])));
  const undeclared = new Set(test.undeclared);
  const offTarget = new Set(test.offTarget);
  test.observed.forEach((call, index) => {
    const step = byCall.get(index);
    let observed = `${call.source ?? "(test)"} -> ${call.destination}: ${call.functions.map((name) => `${name}()`).join(", ")}`;
    if (undeclared.has(index)) {
      const outside = [call.source, call.destination].filter(
        (component) => component !== undefined && !view.components.includes(component),
      );
      observed += `  <- ${outside.join(" and ")} ${outside.length === 1 ? "isn't" : "aren't"} in ${view.view}`;
    }
    if (offTarget.has(index)) observed += "  <- the target declares no relationship for this call";
    rows.push([step === undefined ? "" : pair(view.expected[step]!), observed]);
  });
  test.steps.forEach((call, step) => {
    if (call === null && view.uncovered.includes(step)) rows.push([pair(view.expected[step]!), "missing"]);
  });
  const width = Math.max(...rows.map(([expected]) => expected.length));
  return rows.map(([expected, observed]) => `    ${expected.padEnd(width)}  ${observed}`.trimEnd());
}

function pair(step: PathStep): string {
  return `${step.source} -> ${step.destination}`;
}
