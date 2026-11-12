import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { loadModel } from "./diff.js";
import { componentPaths, type ComponentPath } from "./paths.js";
import { TraceHookError } from "./lang/adapter.js";
import { configuredAdapters } from "./lang/index.js";
import { StructurizrError } from "./structurizr.js";
import type { TraceSettings } from "./trace/env.js";
import { attributes, httpAttributes, messagingAttributes, spansFile } from "./trace/runtime.js";

export const tracesDir = join(".bearing", "traces");

export interface TestOptions {
  // Replaces the TypeScript hook's preload module; tests point it at a build.
  hook?: URL;
  // Extra environment for the test command, on top of this process's.
  env?: NodeJS.ProcessEnv;
  // The test command's output is shown unless this says otherwise.
  stdio?: "inherit" | "ignore";
}

export interface TestResult {
  exitCode: number;
  spans: number;
  // Criterion tags seen on spans, sorted.
  criteria: string[];
  // What the trace hooks say is missing from the traces.
  warnings: string[];
}

export class TestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestError";
  }
}

// Runs a test command with tracing on: clears `.bearing/traces/`, then runs the command with every configured
// language's trace hook in its environment, so each call into a component's code leaves a span there.
export async function runTraced(
  config: Config,
  components: ComponentPath[],
  command: string[],
  options: TestOptions = {},
): Promise<TestResult> {
  const root = resolve(config.root);
  const dir = join(root, tracesDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const settings: TraceSettings = { root, dir, tag: config.tests.tag, components };
  const hookOptions = options.hook === undefined ? {} : { hook: options.hook };
  const adapters = configuredAdapters(config);
  const env = adapters.reduce(
    (env, adapter) =>
      adapter.traceHook.env(
        env,
        settings,
        hookOptions,
        config.languages.filter((language) => language.name === adapter.name),
      ),
    { ...process.env, ...options.env },
  );
  // One string runs through the shell, as `tests.integration` is written; several run as an argument list.
  const [file, ...args] = command.length === 1 ? [command[0]!] : command;
  const child = spawn(file!, args, {
    cwd: root,
    stdio: options.stdio ?? "inherit",
    shell: command.length === 1 || process.platform === "win32",
    env,
  });
  const exitCode = await new Promise<number>((done, fail) => {
    child.on("error", (error) => fail(new TestError(`couldn't run ${command.join(" ")}: ${error.message}`)));
    child.on("exit", (code) => done(code ?? 1));
  });
  // For Criteria coverage: a command that fails without a failed test to show for it, such as a file that doesn't
  // compile, still fails the check.
  writeFileSync(join(dir, runFile), `${JSON.stringify({ exitCode })}\n`);
  const warnings = adapters.flatMap((adapter) => adapter.traceHook.warnings?.(settings) ?? []);
  return { exitCode, ...readSpans(dir), warnings };
}

// What `runTraced` records about the run as a whole, next to the spans and test results.
export const runFile = "run.json";

// Counts the spans in a traces directory and the criteria they carry.
export function readSpans(dir: string): { spans: number; criteria: string[] } {
  const spans = readSpanRecords(dir);
  const criteria = new Set(spans.flatMap((span) => (span.criterion === undefined ? [] : [span.criterion])));
  return { spans: spans.length, criteria: [...criteria].sort() };
}

// A span as Bearing reads it back: one call into a component's exports, a message sent to or received from a queue,
// or an HTTP request.
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  // The function called.
  name: string;
  component: string;
  // The repo-relative file that declares the function.
  file: string;
  // Nanoseconds since the epoch, as OTLP writes them.
  start: bigint;
  // The full name of the test that made the call, and its criterion tag.
  test?: string;
  criterion?: string;
  // For a messaging span: the queue's name, e.g. "appointment-events", and whether the call sent to it or received
  // from it. Its component is empty until the trace path check finds the queue's element.
  queue?: string;
  operation?: "send" | "receive";
  // For an outgoing HTTP request: its method and the host and port it went to, e.g. "GET", "booking-api", 8000. Its
  // component is empty until the trace path check finds the container the host reaches.
  http?: { method: string; host: string; port?: number };
}

// Reads every span in a traces directory.
export function readSpanRecords(dir: string): SpanRecord[] {
  if (!existsSync(dir)) return [];
  const records: SpanRecord[] = [];
  for (const name of readdirSync(dir).filter((name) => spansFile.test(name))) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line === "") continue;
      const request = JSON.parse(line) as OtlpRequest;
      for (const resource of request.resourceSpans) {
        for (const scope of resource.scopeSpans) {
          for (const span of scope.spans) {
            const value = (key: string) =>
              span.attributes.find((attribute) => attribute.key === key)?.value.stringValue;
            const record: SpanRecord = {
              traceId: span.traceId,
              spanId: span.spanId,
              name: span.name,
              component: value(attributes.component) ?? "",
              file: value(attributes.file) ?? "",
              start: BigInt(span.startTimeUnixNano),
            };
            if (span.parentSpanId !== undefined) record.parentSpanId = span.parentSpanId;
            const test = value(attributes.test);
            if (test !== undefined) record.test = test;
            const criterion = value(attributes.criterion);
            if (criterion !== undefined) record.criterion = criterion;
            const queue = value(messagingAttributes.destination);
            const operation = value(messagingAttributes.operation);
            if (queue !== undefined && (operation === "send" || operation === "receive")) {
              record.queue = queue;
              record.operation = operation;
            }
            const host = value(httpAttributes.host);
            if (host !== undefined) {
              const port = Number(
                span.attributes.find((attribute) => attribute.key === httpAttributes.port)?.value.intValue,
              );
              record.http = {
                method: value(httpAttributes.method) ?? "",
                host,
                ...(Number.isInteger(port) && port > 0 ? { port } : {}),
              };
            }
            records.push(record);
          }
        }
      }
    }
  }
  return records;
}

// The parts of an OTLP JSON export `readSpanRecords` reads.
interface OtlpRequest {
  resourceSpans: Array<{
    scopeSpans: Array<{
      spans: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        startTimeUnixNano: string;
        attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
      }>;
    }>;
  }>;
}

// The package.json script `bearing init` sets `tests.integration` to when the repo has it.
export const integrationScript = "test:integration";

// The command `bearing test` runs: the one given after --, else `tests.integration`, else the root package.json's
// `test:integration` script, which a repo often only adds after `bearing init` left `tests.integration` commented out.
// `fallback` says when it's the script, so the caller can say so. Undefined when there's none of them.
export function resolveTestCommand(
  config: Config,
  given: string[] = [],
): { command: string[]; fallback: boolean } | undefined {
  if (given.length > 0) return { command: given, fallback: false };
  if (config.tests.integration !== undefined) return { command: [config.tests.integration], fallback: false };
  let scripts: Record<string, unknown> = {};
  try {
    scripts =
      (JSON.parse(readFileSync(join(config.root, "package.json"), "utf8")) as { scripts?: typeof scripts }).scripts ??
      {};
  } catch {
    // No package.json, or not JSON: no script to fall back to.
  }
  return integrationScript in scripts ? { command: [`npm run ${integrationScript}`], fallback: true } : undefined;
}

export function testCommand(): Command {
  return new Command("test")
    .description(
      "run the tests with tracing on, writing a span to .bearing/traces/ for each call into a component; runs tests.integration from the config, or else package.json's test:integration script, unless given a command after --",
    )
    .argument("[command...]", "the test command, e.g. -- npm run test:integration")
    .action(async function (this: Command, command: string[]) {
      try {
        const config = loadConfig();
        const toRun = resolveTestCommand(config, command);
        if (toRun === undefined) {
          this.error(
            `error: no test command; pass one after --, set "tests.integration" in .bearing/config.yaml, or add a "${integrationScript}" script to package.json`,
          );
        }
        if (toRun.fallback) {
          process.stderr.write(
            `bearing: "tests.integration" isn't set in .bearing/config.yaml, so running ${toRun.command[0]}; set it to say which command to run\n`,
          );
        }
        const target = await loadModel(join(config.root, config.model), () => config);
        const result = await runTraced(config, componentPaths(target), toRun.command);
        for (const warning of result.warnings) process.stderr.write(`bearing: warning: ${warning}\n`);
        process.stderr.write(`${summary(result)}\n`);
        process.exitCode = result.exitCode;
      } catch (error) {
        if (
          error instanceof ConfigError ||
          error instanceof StructurizrError ||
          error instanceof TestError ||
          error instanceof TraceHookError
        ) {
          this.error(`error: ${error.message}`);
        }
        throw error;
      }
    });
}

function summary({ spans, criteria }: Pick<TestResult, "spans" | "criteria">): string {
  const tagged = criteria.length === 0 ? "none tagged with a criterion" : `covering ${criteria.join(", ")}`;
  return `bearing: wrote ${spans} ${spans === 1 ? "span" : "spans"} to ${tracesDir}/, ${tagged}`;
}
