import type { Config } from "./config.js";
import { dynamicViewKey, type Model } from "./model.js";
import { componentPaths } from "./paths.js";
import { queueTargets } from "./queues.js";
import type { Requirement } from "./requirements.js";
import { routeFor, type ServiceRoute } from "./services.js";
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
// A queue is traced too, through the messaging spans the Python and Go hooks record when code sends to it and receives
// from it, which carry the trace across the queue. So a view's steps into and out of a queue are expected. A test can
// stand in for a queue as it does for the step into the system: a step from a queue into a component matches a call
// into it from the test, as when the test hands the consumer its messages.
//
// An HTTP request is traced too, through the client spans the hooks record for it. When its host is a Kubernetes
// Service's name, it stands for a call from the calling component into the container the Service reaches; any other
// host, such as localhost, is ignored. At that level a view says how containers work together, so a step between two
// containers over HTTP is expected when the source has traced code and the destination a Service, and a call takes a
// step when each of its ends is the step's element or one of that element's components. A view that names a
// container declares its components with it. Each service's tests take their own part of the view, as a story's tests
// already share its steps.
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
  // The functions called, in order, without repeats; for an HTTP request, its method and host, e.g. "GET booking-api".
  functions: string[];
  // Whether it's an HTTP request into a container through its Service.
  http?: true;
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
  inputs: {
    target: Model;
    requirements: Requirement[];
    issues: number[];
    tests: TestRecord[];
    spans: SpanRecord[];
    // The element each queue's name stands for, from the Terraform.
    queueNames?: Map<string, string>;
    // The containers Kubernetes Services' names reach, from the manifests.
    routes?: ServiceRoute[];
  },
): ViewPaths[] {
  const { target, requirements, issues, tests } = inputs;
  const queues = queueTargets(target);
  for (const id of inputs.queueNames?.values() ?? []) queues.add(id);
  const routes = inputs.routes ?? [];
  const spans = withRequests(withQueues(inputs.spans, queues, inputs.queueNames ?? new Map()), routes);
  const components = componentPaths(target).map((component) => component.id);
  const traced = new Set([...components, ...queues]);
  const declaredCalls = new Set([...target.relationships.values()].map(callKey));
  // Each component's container, for the steps a view takes between containers.
  const parents = new Map(
    [...target.elements.values()].flatMap((element) =>
      element.type === "component" && element.parent !== undefined ? [[element.id, element.parent] as const] : [],
    ),
  );
  const tracedContainers = new Set(components.flatMap((component) => parents.get(component) ?? []));
  const reached = new Set(routes.map((route) => route.container));
  const overHttp = (source: string, destination: string) =>
    [...target.relationships.values()].some(
      (relationship) =>
        relationship.destination === destination &&
        (relationship.source === source || relationship.source === parents.get(source)) &&
        httpTechnology.test(relationship.technology),
    );
  const expectedStep = (source: string, destination: string) =>
    (traced.has(source) && traced.has(destination)) ||
    ((traced.has(source) || tracedContainers.has(source)) && reached.has(destination) && overHttp(source, destination));
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
      const named = [...new Set(view?.steps.flatMap((step) => [step.source, step.destination]) ?? [])];
      const base = {
        issue: `#${issue}`,
        view: key,
        description: view?.description ?? "",
        components: named,
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
          .filter((step) => expectedStep(step.source, step.destination))
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
      // A container the view names declares its components with it.
      const declared = new Set([
        ...named,
        ...[...parents].flatMap(([component, container]) => (named.includes(container) ? [component] : [])),
      ]);
      const paths = [...passing.values()].flatMap((test) => {
        // A passing test with no spans took none of the path.
        const found = [...(traces.get(test.name)?.values() ?? [])];
        return (found.length === 0 ? [[]] : found).map((trace) => {
          const observed = observedPath(trace);
          const match = matchPath(expected, observed, declared, queues, parents);
          const offTarget = offTargetCalls(observed, declaredCalls, parents);
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
    const http = span.http !== undefined;
    const last = calls.at(-1);
    if (
      last !== undefined &&
      last.source === source &&
      last.destination === span.component &&
      source !== undefined &&
      (last.http === true) === http
    ) {
      if (!last.functions.includes(span.name)) last.functions.push(span.name);
    } else {
      const call: ObservedCall =
        source === undefined
          ? { destination: span.component, functions: [span.name] }
          : { source, destination: span.component, functions: [span.name] };
      if (http) call.http = true;
      calls.push(call);
    }
  }
  return calls;
}

// Finds the longest unbroken run of expected steps in the observed path, earliest in the view on a tie, then the calls
// between its first match and its last that involve a component the view doesn't declare. `parents` gives each
// component's container, so a call between two containers' components takes a step between the containers.
export function matchPath(
  expected: PathStep[],
  observed: ObservedCall[],
  declared: Set<string>,
  queues: Set<string> = new Set(),
  parents: Map<string, string> = new Map(),
): Pick<TestPath, "steps" | "undeclared"> {
  const taken = (run: Array<number | null>) => run.filter((index) => index !== null).length;
  let steps: Array<number | null> = expected.map(() => null);
  for (let start = 0; start < expected.length; start++) {
    const run = matchRun(expected, observed, start, queues, parents);
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
// found. Steps outside the run are null. Each end of a call matches the step's element or one of its components. A
// step out of a queue also matches a call from the test, standing in for it.
function matchRun(
  expected: PathStep[],
  observed: ObservedCall[],
  start: number,
  queues: Set<string>,
  parents: Map<string, string>,
): Array<number | null> {
  const within = (end: string | undefined, element: string) => end === element || parents.get(end ?? "") === element;
  const steps: Array<number | null> = [];
  let from = 0;
  for (const [position, step] of expected.entries()) {
    if (position < start) {
      steps.push(null);
      continue;
    }
    const index = observed.findIndex(
      (call, at) =>
        at >= from &&
        within(call.destination, step.destination) &&
        (within(call.source, step.source) || (call.source === undefined && queues.has(step.source))),
    );
    // Once a step is missing, the run is broken, so the rest are outside it too.
    steps.push(index === -1 ? null : index);
    from = index === -1 ? Infinity : index + 1;
  }
  return steps;
}

const callKey = (call: { source?: string; destination: string }) => `${call.source}->${call.destination}`;

// Messaging spans with their queue's element as their component: the one the Terraform gives the queue's name, or,
// when the Terraform names no queue, the target's only queue if it has one. A queue neither names reads as its name,
// an element the target doesn't have.
function withQueues(spans: SpanRecord[], queues: Set<string>, names: Map<string, string>): SpanRecord[] {
  const only = names.size === 0 && queues.size === 1 ? [...queues][0] : undefined;
  return spans.map((span) =>
    span.queue === undefined ? span : { ...span, component: names.get(span.queue) ?? only ?? span.queue },
  );
}

// The indexes of calls between two components that the target has no relationship for. A call from the test has no
// source, so it's never one. An HTTP request into a container is on target when the target relates the caller, or the
// caller's container, to it.
export function offTargetCalls(
  observed: ObservedCall[],
  declared: Set<string>,
  parents: Map<string, string> = new Map(),
): number[] {
  return observed.flatMap((call, index) => {
    if (call.source === undefined || declared.has(callKey(call))) return [];
    const container = parents.get(call.source);
    if (call.http === true && container !== undefined && declared.has(`${container}->${call.destination}`)) return [];
    return [index];
  });
}

// A relationship over HTTP: its technology mentions HTTP, HTTPS or REST, e.g. "JSON over HTTP".
const httpTechnology = /\b(https?|rest)\b/i;

// HTTP spans with the container their host's Service reaches as their component. A request to any other host isn't a
// call Bearing can name, so it's left out; nothing nests under a client span.
function withRequests(spans: SpanRecord[], routes: ServiceRoute[]): SpanRecord[] {
  return spans.flatMap((span) => {
    if (span.http === undefined) return [span];
    const route = routeFor(routes, span.http.host, span.http.port);
    return route === undefined ? [] : [{ ...span, component: route.container }];
  });
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
    const called = call.functions.map((name) => (call.http === true ? name : `${name}()`)).join(", ");
    let observed = `${call.source ?? "(test)"} -> ${call.destination}: ${called}`;
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
