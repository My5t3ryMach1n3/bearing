import { readTraceSettings, tracedFile } from "./env.js";
import { instrumentModule } from "./transform.js";

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
