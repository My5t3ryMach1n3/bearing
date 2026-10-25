import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import * as nodeModule from "node:module";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { loadModel } from "./diff.js";
import { componentPaths, type ComponentPath } from "./paths.js";
import { StructurizrError } from "./structurizr.js";
import { traceEnv, type TraceSettings } from "./trace/env.js";
import { attributes, spansFile } from "./trace/runtime.js";

export const tracesDir = join(".bearing", "traces");

// The module every Node process the tests start preloads. See src/trace/register.ts.
const defaultHook = new URL("./trace/register.js", import.meta.url);

export interface TestOptions {
  // The preload module; tests point it at a build.
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
}

export class TestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestError";
  }
}

// Runs a test command with tracing on: clears `.bearing/traces/`, then runs the command with the hook preloaded
// into every Node process it starts, so each call into a component's exports leaves a span there.
export async function runTraced(
  config: Config,
  components: ComponentPath[],
  command: string[],
  options: TestOptions = {},
): Promise<TestResult> {
  // `registerHooks` arrived in Node 22.15; `engines` only promises 22.
  if (typeof (nodeModule as { registerHooks?: unknown }).registerHooks !== "function") {
    throw new TestError(`tracing needs Node.js 22.15 or later; this is ${process.version}`);
  }
  const root = resolve(config.root);
  const dir = join(root, tracesDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const settings: TraceSettings = { root, dir, tag: config.tests.tag, components };
  const env = { ...process.env, ...options.env };
  const nodeOptions = [env.NODE_OPTIONS, `--import=${(options.hook ?? defaultHook).href}`].filter(Boolean).join(" ");
  // One string runs through the shell, as `tests.integration` is written; several run as an argument list.
  const [file, ...args] = command.length === 1 ? [command[0]!] : command;
  const child = spawn(file!, args, {
    cwd: root,
    stdio: options.stdio ?? "inherit",
    shell: command.length === 1 || process.platform === "win32",
    env: { ...env, NODE_OPTIONS: nodeOptions, [traceEnv]: JSON.stringify(settings) },
  });
  const exitCode = await new Promise<number>((done, fail) => {
    child.on("error", (error) => fail(new TestError(`couldn't run ${command.join(" ")}: ${error.message}`)));
    child.on("exit", (code) => done(code ?? 1));
  });
  return { exitCode, ...readSpans(dir) };
}

// Counts the spans in a traces directory and the criteria they carry.
export function readSpans(dir: string): { spans: number; criteria: string[] } {
  const spans = readSpanRecords(dir);
  const criteria = new Set(spans.flatMap((span) => (span.criterion === undefined ? [] : [span.criterion])));
  return { spans: spans.length, criteria: [...criteria].sort() };
}

// A span as Bearing reads it back: one call into a component's exports.
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
        attributes: Array<{ key: string; value: { stringValue?: string } }>;
      }>;
    }>;
  }>;
}

export function testCommand(): Command {
  return new Command("test")
    .description(
      "run the tests with tracing on, writing a span to .bearing/traces/ for each call into a component; runs tests.integration from the config unless given a command after --",
    )
    .argument("[command...]", "the test command, e.g. -- npm run test:integration")
    .action(async function (this: Command, command: string[]) {
      try {
        const config = loadConfig();
        const toRun = command.length > 0 ? command : config.tests.integration;
        if (toRun === undefined) {
          this.error('error: no test command; pass one after --, or set "tests.integration" in .bearing/config.yaml');
        }
        const target = await loadModel(join(config.root, config.model), () => config);
        const result = await runTraced(config, componentPaths(target), typeof toRun === "string" ? [toRun] : toRun);
        process.stderr.write(`${summary(result)}\n`);
        process.exitCode = result.exitCode;
      } catch (error) {
        if (error instanceof ConfigError || error instanceof StructurizrError || error instanceof TestError) {
          this.error(`error: ${error.message}`);
        }
        throw error;
      }
    });
}

function summary({ spans, criteria }: TestResult): string {
  const tagged = criteria.length === 0 ? "none tagged with a criterion" : `covering ${criteria.join(", ")}`;
  return `bearing: wrote ${spans} ${spans === 1 ? "span" : "spans"} to ${tracesDir}/, ${tagged}`;
}
