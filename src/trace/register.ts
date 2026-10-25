import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { readTraceSettings, tracedFile } from "./env.js";
import { installRuntime } from "./runtime.js";
import { instrumentCommonJs, instrumentModule } from "./transform.js";

// The module `bearing test` preloads into every Node process the test command starts, with `--import`. It installs
// the span runtime and a module hook that wraps the exports of every file under a component path, for ES modules
// and CommonJS alike. Vite's entry is swapped for one that adds the trace plugin to each config, which is how
// Vitest's own module runner gets instrumented too.

// Asks the hook for Vite's real entry, from inside the shim that replaces it.
const original = "bearing-original";

const settings = readTraceSettings();
if (settings !== undefined) {
  installRuntime(settings);
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:")) return result;
      const parsed = new URL(url);
      const path = fileURLToPath(parsed);
      if (/[\\/]node_modules[\\/]vite[\\/]dist[\\/]node[\\/]index\.js$/.test(path)) {
        if (parsed.searchParams.has(original)) return result;
        parsed.searchParams.set(original, "");
        return { format: "module", source: viteShim(parsed.href), shortCircuit: true };
      }
      const traced = tracedFile(path, settings);
      if (traced === undefined) return result;
      const code = (result.source ?? readFileSync(path)).toString();
      if (result.format === "module" || result.format === "module-typescript") {
        return { ...result, source: instrumentModule(code, path, traced) };
      }
      if (result.format === "commonjs" || result.format === "commonjs-typescript") {
        return { ...result, source: instrumentCommonJs(code, traced) };
      }
      return result;
    },
  });
}

// Vite's entry with the trace plugin added to every config it's given to resolve or serve. The shim's own exports
// win over `export *`'s.
function viteShim(vite: string): string {
  const plugin = new URL("./vite.js", import.meta.url).href;
  return [
    `export * from ${JSON.stringify(vite)};`,
    `import * as vite from ${JSON.stringify(vite)};`,
    `import { withTracePlugin } from ${JSON.stringify(plugin)};`,
    `export function createServer(config, ...rest) { return vite.createServer(withTracePlugin(config), ...rest); }`,
    `export function resolveConfig(config, ...rest) { return vite.resolveConfig(withTracePlugin(config), ...rest); }`,
  ].join("\n");
}
