import { describe, expect, it } from "vitest";
import { withTracePlugin } from "../src/trace/vite.js";

const names = (config: unknown) => ((config as { plugins: Array<{ name: string }> }).plugins ?? []).map((p) => p.name);

describe("withTracePlugin", () => {
  it("adds the plugin to an inline config, after the project's own", () => {
    expect(names(withTracePlugin({ plugins: [{ name: "react" }] }))).toEqual(["react", "bearing-trace"]);
    expect(names(withTracePlugin(undefined))).toEqual(["bearing-trace"]);
  });

  it("adds it once when a config is resolved and then served", () => {
    const resolved = withTracePlugin({ root: "/repo" });
    expect(withTracePlugin(resolved)).toBe(resolved);
  });

  it("passes a config Vite has already resolved through unchanged", () => {
    const resolved = { plugins: [{ name: "vite:esbuild" }], getSortedPlugins: () => [] };
    expect(withTracePlugin(resolved)).toBe(resolved);
  });
});
