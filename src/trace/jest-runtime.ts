import { readTraceSettings, tracedFile, type TraceSettings } from "./env.js";
import type { TraceRuntime } from "./runtime.js";
import { instrumentCommonJs, instrumentModule, runtimeKey } from "./transform.js";

// Jest never loads a test's modules through Node's loader: `jest-runtime` reads each file, runs it through Jest's
// `ScriptTransformer` and evaluates it in the test environment's `vm` context, whose `globalThis` is the
// environment's own. Jest makes one `Runtime` per test file and hands it both, so the hook replaces the `Runtime`
// class with one that instruments component files after Jest's transform, and installs the trace runtime on the
// environment's global, where the instrumented code looks for it and where Jest keeps the running test's name.

// The parts of Jest's `ScriptTransformer` this wraps. Both methods return the code Jest evaluates.
interface Transformer {
  transformSource(path: string, content: string, options: TransformOptions): { code: string };
  transformSourceAsync(path: string, content: string, options: TransformOptions): Promise<{ code: string }>;
}

interface TransformOptions {
  // Set when Jest runs ES modules natively, so the code it returns is still an ES module.
  supportsStaticESM?: boolean;
}

// Jest's `Runtime` constructor: config, environment, resolver, transformer, then more Bearing doesn't use.
type RuntimeClass = new (
  config: unknown,
  environment: { global: object },
  resolver: unknown,
  transformer: Transformer,
  ...rest: unknown[]
) => object;

export function withTracedRuntime(exports: { default: RuntimeClass }): void {
  const settings = readTraceSettings();
  const runtime = (globalThis as Record<symbol, TraceRuntime | undefined>)[Symbol.for(runtimeKey)];
  if (settings === undefined || runtime === undefined) return;
  const traced = { settings, runtime };
  exports.default = class Runtime extends exports.default {
    constructor(...args: ConstructorParameters<RuntimeClass>) {
      super(...args);
      const [, environment, , transformer] = args;
      Object.defineProperty(environment.global, Symbol.for(runtimeKey), {
        value: traced.runtime.within(environment.global),
        configurable: true,
      });
      instrument(transformer, traced.settings);
    }
  };
}

const instrumented = new WeakSet<Transformer>();

function instrument(transformer: Transformer, settings: TraceSettings): void {
  if (instrumented.has(transformer)) return;
  instrumented.add(transformer);
  const { transformSource, transformSourceAsync } = transformer;
  // Jest caches what its transform returns, so the rewrite runs on every load, not just the first.
  const rewrite = <T extends { code: string }>(path: string, result: T, options: TransformOptions): T => {
    const traced = tracedFile(path, settings);
    if (traced === undefined) return result;
    const code =
      options.supportsStaticESM === true
        ? instrumentModule(result.code, path, traced)
        : instrumentCommonJs(result.code, traced);
    return { ...result, code };
  };
  transformer.transformSource = function (this: Transformer, path, content, options) {
    return rewrite(path, transformSource.call(this, path, content, options), options);
  };
  transformer.transformSourceAsync = async function (this: Transformer, path, content, options) {
    return rewrite(path, await transformSourceAsync.call(this, path, content, options), options);
  };
}
