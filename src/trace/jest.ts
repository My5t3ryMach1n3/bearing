import { relative, sep } from "node:path";
import { readTraceSettings } from "./env.js";
import type { TestOutcome, TraceRuntime } from "./runtime.js";
import { runtimeKey } from "./transform.js";

// Jest has no plugins, and its reporters come only from its own config. Every way of running Jest goes through
// `runCLI` in `@jest/core`, though, which returns every test's result, so the hook replaces that module's exports with
// ones whose `runCLI` records each test's outcome before returning.

// The parts of Jest's `AggregatedResult` this reads.
interface JestResults {
  results: {
    testResults: Array<{
      testFilePath: string;
      testResults: Array<{ fullName: string; status: string }>;
    }>;
  };
}

type RunCli = (...args: unknown[]) => Promise<JestResults>;

export function withTestOutcomes(core: { runCLI: RunCli }): object {
  const runCLI = core.runCLI;
  // The exports are getters that can't be redefined, so this copies them.
  return {
    __esModule: true,
    ...core,
    async runCLI(...args: unknown[]) {
      const output = await runCLI(...args);
      recordOutcomes(output.results);
      return output;
    },
  };
}

export function recordOutcomes(results: JestResults["results"]): void {
  const settings = readTraceSettings();
  const runtime = (globalThis as Record<symbol, TraceRuntime | undefined>)[Symbol.for(runtimeKey)];
  if (settings === undefined || runtime === undefined) return;
  for (const file of results.testResults) {
    const path = relative(settings.root, file.testFilePath).split(sep).join("/");
    for (const test of file.testResults) {
      // Jest's other statuses, such as "pending", "todo" and "disabled", are tests that didn't run.
      const status: TestOutcome["status"] =
        test.status === "passed" || test.status === "failed" ? test.status : "skipped";
      runtime.test({ name: test.fullName, file: path, status });
    }
  }
}
