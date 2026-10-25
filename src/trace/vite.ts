import { relative, sep } from "node:path";
import { readTraceSettings, tracedFile, type TraceSettings } from "./env.js";
import type { TestOutcome, TraceRuntime } from "./runtime.js";
import { instrumentModule, runtimeKey } from "./transform.js";

const name = "bearing-trace";

// Vitest runs code through Vite's module runner rather than Node's loader, so the Node hook never sees it. The hook
// adds this plugin to every Vite dev server the test command starts instead. It runs after Vite has compiled
// TypeScript to JavaScript, and before Vite rewrites the module for its runner.
export function tracePlugin() {
  const settings = readTraceSettings();
  return {
    name,
    apply: "serve" as const,
    enforce: "post" as const,
    transform(code: string, id: string) {
      if (settings === undefined || id.startsWith("\0")) return undefined;
      const path = id.replace(/[?#].*$/, "");
      const traced = tracedFile(path, settings);
      // CommonJS is left to Node: Vite's runner hands it to Node's own `require`.
      if (traced === undefined || /\.c[jt]s$/.test(path)) return undefined;
      // Edits keep every line where it was, so the previous plugins' source map still holds.
      return { code: instrumentModule(code, path, traced), map: null };
    },
    // Adds a reporter that records how each test ended. It runs before Vitest creates its reporters, once per
    // project, so it adds the reporter once per Vitest.
    configureVitest({ vitest }: { vitest: { config: { reporters: unknown[] } } }) {
      if (settings === undefined || reporting.has(vitest)) return;
      reporting.add(vitest);
      vitest.config.reporters.push(outcomeReporter(settings));
    },
  };
}

const reporting = new WeakSet<object>();

// The parts of Vitest's `TestCase` the reporter reads.
interface TestCase {
  fullName: string;
  module: { moduleId: string };
  result(): { state: "passed" | "failed" | "skipped" | "pending" };
}

export function outcomeReporter(settings: TraceSettings) {
  return {
    onTestCaseResult(testCase: TestCase) {
      const runtime = (globalThis as Record<symbol, TraceRuntime | undefined>)[Symbol.for(runtimeKey)];
      const { state } = testCase.result();
      const status: TestOutcome["status"] = state === "passed" || state === "failed" ? state : "skipped";
      const file = relative(settings.root, testCase.module.moduleId).split(sep).join("/");
      runtime?.test({ name: testCase.fullName, file, status });
    },
  };
}

// Adds the plugin to a Vite config about to be resolved. Vitest 4 passes `createServer` an inline config; Vitest 5
// resolves its config first and passes that, by which time the plugins are fixed, so `resolveConfig` adds it then.
export function withTracePlugin(config: unknown): unknown {
  const inline = (config ?? {}) as { plugins?: unknown[]; getSortedPlugins?: unknown };
  const plugins = inline.plugins ?? [];
  const added = plugins.some((plugin) => (plugin as { name?: unknown } | null)?.name === name);
  if (added || typeof inline.getSortedPlugins === "function") return config;
  return { ...inline, plugins: [...plugins, tracePlugin()] };
}
