import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { types } from "node:util";
import { threadId } from "node:worker_threads";
import { runtimeKey } from "./transform.js";

// What instrumented modules call. See `instrumentModule` and `instrumentCommonJs`.
export interface TraceRuntime {
  module(component: string, file: string): TracedModule;
  // Records how a test ended. The runner's main process calls it once per test, from a reporter Bearing adds.
  test(outcome: TestOutcome): void;
  // The runtime for code that runs with another global, such as a Jest test environment's, where the running test's
  // name is kept.
  within(global: object): TraceRuntime;
}

// A test as the runner reports it once it has finished: passed only if it ran to the end with no failure.
export interface TestOutcome {
  // The full name, as the matcher state holds it while the test runs.
  name: string;
  // Repo-relative.
  file?: string;
  status: "passed" | "failed" | "skipped";
}

// One line of a tests file: the outcome and the criterion tag in the test's name, if it has one.
export interface TestRecord extends TestOutcome {
  criterion?: string;
}

export interface TracedModule {
  // Returns a function that records a span around each call, or the value itself if it isn't a plain function.
  wrap<T>(value: T, name: string): T;
  wrapExports(module: { exports: unknown }): void;
}

export interface RuntimeOptions {
  // Where span files go, one per process and thread.
  dir: string;
  // The criterion tag template from config, e.g. "#<issue>/AC<n>".
  tag: string;
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  test?: string;
  name: string;
  component: string;
  file: string;
  start: bigint;
}

// Attribute keys on every span. `code.*` follow OpenTelemetry's semantic conventions; `bearing.*` are Bearing's own.
export const attributes = {
  component: "bearing.component",
  criterion: "bearing.criterion",
  test: "bearing.test",
  function: "code.function.name",
  file: "code.file.path",
} as const;

// Span files are named `spans-<pid>-<thread>.jsonl` and test files `tests-<pid>-<thread>.jsonl`.
export const spansFile = /^spans-.*\.jsonl$/;
export const testsFile = /^tests-.*\.jsonl$/;

// Spans are written as OTLP JSON, one `ExportTraceServiceRequest` per line: the OpenTelemetry file exporter's
// format. Each call from a test into a component is written once it ends, with the calls it made, so nothing is lost
// when a runner terminates a worker thread, which runs no exit handlers.

// Vitest and Jest share Jest's matcher state, which holds the full name of the running test.
const matchers = Symbol.for("$$jest-matchers-object");

export function installRuntime(options: RuntimeOptions): TraceRuntime {
  const existing = (globalThis as Record<symbol, unknown>)[Symbol.for(runtimeKey)];
  if (existing !== undefined) return existing as TraceRuntime;

  const file = join(options.dir, `spans-${process.pid}-${threadId}.jsonl`);
  const testsPath = join(options.dir, `tests-${process.pid}-${threadId}.jsonl`);
  const criterion = criterionPattern(options.tag);
  const storage = new AsyncLocalStorage<Span>();
  // Span IDs only need to be unique within a trace: a random prefix per process and a counter.
  const idPrefix = randomBytes(4).toString("hex");
  let nextId = 0;
  const processTrace = randomBytes(16).toString("hex");
  const tests = new Map<string, { traceId: string; criterion?: string }>();
  // Wall-clock nanoseconds from the monotonic clock.
  const epoch = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();
  let pending: object[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const request = {
      resourceSpans: [
        {
          resource: { attributes: [attribute("service.name", "bearing-test"), attribute("process.pid", process.pid)] },
          scopeSpans: [{ scope: { name: "bearing" }, spans: pending }],
        },
      ],
    };
    pending = [];
    if (fd === undefined) {
      mkdirSync(options.dir, { recursive: true });
      fd = openSync(file, "a");
    }
    writeSync(fd, `${JSON.stringify(request)}\n`);
  };
  let fd: number | undefined;
  process.on("exit", flush);

  const currentTest = (global: object): string | undefined => {
    const name = (global as Record<symbol, { state?: { currentTestName?: unknown } } | undefined>)[matchers]?.state
      ?.currentTestName;
    return typeof name === "string" && name !== "" ? name : undefined;
  };
  const testInfo = (test: string) => {
    let info = tests.get(test);
    if (info === undefined) {
      info = { traceId: randomBytes(16).toString("hex"), criterion: criterion.exec(test)?.[0] };
      tests.set(test, info);
    }
    return info;
  };

  const start = (name: string, component: string, file: string, global: object): Span => {
    const test = currentTest(global);
    const parent = storage.getStore();
    const spanId = `${idPrefix}${(nextId++).toString(16).padStart(8, "0")}`;
    const begin = epoch + process.hrtime.bigint();
    // A call that outlives its test, such as a timer, starts a new trace rather than joining the last one.
    if (parent !== undefined && parent.test === test) {
      return {
        traceId: parent.traceId,
        spanId,
        parentSpanId: parent.spanId,
        test,
        name,
        component,
        file,
        start: begin,
      };
    }
    const traceId = test === undefined ? processTrace : testInfo(test).traceId;
    return { traceId, spanId, test, name, component, file, start: begin };
  };

  const end = (span: Span, error?: unknown) => {
    const spanAttributes = [
      attribute(attributes.component, span.component),
      attribute(attributes.function, span.name),
      attribute(attributes.file, span.file),
    ];
    if (span.test !== undefined) {
      spanAttributes.push(attribute(attributes.test, span.test));
      const tag = testInfo(span.test).criterion;
      if (tag !== undefined) spanAttributes.push(attribute(attributes.criterion, tag));
    }
    const record = {
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
      name: span.name,
      kind: 1,
      startTimeUnixNano: span.start.toString(),
      endTimeUnixNano: (epoch + process.hrtime.bigint()).toString(),
      attributes: spanAttributes,
      status: error === undefined ? { code: 1 } : { code: 2, message: errorMessage(error) },
    };
    pending.push(record);
    if (span.parentSpanId === undefined) flush();
  };

  const traced = new WeakMap<object, unknown>();
  const wrappers = new WeakSet<object>();
  const wrap = <T>(value: T, name: string, component: string, file: string, global: object): T => {
    if (typeof value !== "function" || wrappers.has(value) || isClass(value)) return value;
    const known = traced.get(value);
    if (known !== undefined) return known as T;
    const fn = value as unknown as (...args: unknown[]) => unknown;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const span = start(name, component, file, global);
      let result: unknown;
      try {
        result = storage.run(span, () =>
          new.target === undefined ? Reflect.apply(fn, this, args) : Reflect.construct(fn, args, new.target),
        );
      } catch (error) {
        end(span, error);
        throw error;
      }
      // Only real promises: calling `then` on other thenables, such as query builders, can have side effects.
      if (types.isPromise(result)) {
        result.then(
          () => end(span),
          (error: unknown) => end(span, error),
        );
      } else {
        end(span);
      }
      return result;
    };
    Object.defineProperties(wrapper, {
      name: { value: fn.name, configurable: true },
      length: { value: fn.length, configurable: true },
    });
    Object.assign(wrapper, fn);
    if (Object.hasOwn(fn, "prototype")) wrapper.prototype = fn.prototype as object;
    Object.setPrototypeOf(wrapper, Object.getPrototypeOf(fn) as object);
    traced.set(value, wrapper);
    wrappers.add(wrapper);
    return wrapper as T;
  };

  const test = (outcome: TestOutcome) => {
    const tag = criterion.exec(outcome.name)?.[0];
    const record: TestRecord = tag === undefined ? outcome : { ...outcome, criterion: tag };
    mkdirSync(options.dir, { recursive: true });
    appendFileSync(testsPath, `${JSON.stringify(record)}\n`);
  };
  const within = (global: object): TraceRuntime => ({
    module(component, file) {
      return {
        wrap: (value, name) => wrap(value, name, component, file, global),
        wrapExports(module) {
          if (typeof module.exports === "function") {
            module.exports = wrap(module.exports, module.exports.name || "default", component, file, global);
          }
          const exports = module.exports;
          if ((typeof exports !== "object" && typeof exports !== "function") || exports === null) return;
          for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(exports))) {
            // Getters are re-exports in compiled TypeScript; the module that declares the function wraps it.
            if (!descriptor.writable || typeof descriptor.value !== "function") continue;
            (exports as Record<string, unknown>)[key] = wrap(descriptor.value, key, component, file, global);
          }
        },
      };
    },
    test,
    within,
  });
  const runtime = within(globalThis);
  Object.defineProperty(globalThis, Symbol.for(runtimeKey), { value: runtime });
  return runtime;
}

// Matches a test's criterion tag in its name, e.g. "#2/AC1" for the template "#<issue>/AC<n>".
export function criterionPattern(tag: string): RegExp {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace("<issue>", "\\d+").replace("<n>", "\\d+"));
}

// A criterion's tag as tests write it, e.g. "#2/AC1" for the template "#<issue>/AC<n>".
export function criterionTag(tag: string, issue: number, criterion: number): string {
  return tag.replaceAll("<issue>", String(issue)).replaceAll("<n>", String(criterion));
}

// OTLP JSON writes 64-bit integers as strings.
function attribute(key: string, value: string | number) {
  return { key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } };
}

function isClass(fn: object): boolean {
  return /^class\b/.test(Function.prototype.toString.call(fn));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
