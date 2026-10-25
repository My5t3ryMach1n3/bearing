import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { instrumentCommonJs, instrumentModule, runtimeKey, type TracedFile } from "../src/trace/transform.js";

const traced: TracedFile = { component: "basketService", file: "src/basket-service/index.ts" };
const key = Symbol.for(runtimeKey);

// Stands in for the trace runtime, recording each call a wrapper sees as "<component>.<name>".
function stubRuntime() {
  const calls: string[] = [];
  const runtime = {
    module: (component: string) => ({
      wrap: (value: unknown, name: string) =>
        typeof value === "function"
          ? (...args: unknown[]) => {
              calls.push(`${component}.${name}`);
              return (value as (...args: unknown[]) => unknown)(...args);
            }
          : value,
      wrapExports(module: { exports: Record<string, unknown> }) {
        for (const [name, value] of Object.entries(module.exports)) {
          module.exports[name] = this.wrap(value, name);
        }
      },
    }),
  };
  Object.defineProperty(globalThis, key, { value: runtime, configurable: true });
  return calls;
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[key];
});

// Instruments `code` as `name` and imports it.
async function load(name: string, code: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const file = join(mkdtempSync(join(tmpdir(), "bearing-transform-")), name);
  writeFileSync(file, name.endsWith(".cjs") ? instrumentCommonJs(code, traced) : instrumentModule(code, file, traced));
  return (await import(pathToFileURL(file).href)) as Record<string, (...args: unknown[]) => unknown>;
}

describe("instrumentModule", () => {
  it("wraps every kind of exported function, under the name it's exported as", async () => {
    const calls = stubRuntime();
    const module = await load(
      "every-kind.mjs",
      [
        "export function declared() { return 1; }",
        "export const arrow = () => 2, notAFunction = 3;",
        "export async function later() { return 4; }",
        "function listed() { return 5; }",
        "const renamed = () => 6;",
        "export { listed, renamed as alias };",
        "export default function () { return 7; }",
      ].join("\n"),
    );
    expect(module.declared!()).toBe(1);
    expect(module.arrow!()).toBe(2);
    expect(module.notAFunction).toBe(3);
    expect(await module.later!()).toBe(4);
    expect(module.listed!()).toBe(5);
    expect(module.alias!()).toBe(6);
    expect(module.default!()).toBe(7);
    expect(calls).toEqual([
      "basketService.declared",
      "basketService.arrow",
      "basketService.later",
      "basketService.listed",
      "basketService.alias",
      "basketService.default",
    ]);
  });

  it("wraps a default-exported expression", async () => {
    const calls = stubRuntime();
    const module = await load("default-expression.mjs", "export default (a, b) => a + b;");
    expect(module.default!(2, 3)).toBe(5);
    expect(calls).toEqual(["basketService.default"]);
  });

  it("leaves re-exports to the module that declares them", () => {
    const code = 'export { saveBasket } from "../basket-repository/index.js";\nexport * from "./quantity.js";\n';
    expect(instrumentModule(code, "index.ts", traced)).toBe(code);
  });

  it("leaves imports that are exported again to the module that declares them", () => {
    const code = 'import { saveBasket } from "../basket-repository/index.js";\nexport { saveBasket };\n';
    expect(instrumentModule(code, "index.ts", traced)).toBe(code);
  });

  it("runs the module unchanged when tracing is off", async () => {
    const module = await load("off.mjs", "export const answer = () => 42;");
    expect(module.answer!()).toBe(42);
  });

  it("keeps TypeScript as TypeScript, with every line where it was", () => {
    const code = [
      'import type { Ports } from "./ports.js";',
      "export const addItem = async (ports: Ports, sku: string): Promise<void> => {",
      "  await ports.save(sku);",
      "};",
      "export function count(items: string[]): number;",
      "export function count(items: string[]) {",
      "  return items.length;",
      "}",
      "export declare function ambient(): void;",
      "export interface Basket { items: string[] }",
    ].join("\n");
    const result = instrumentModule(code, "index.ts", traced);
    const lines = result.split("\n");
    expect(lines.slice(0, 10)).toEqual([
      'import type { Ports } from "./ports.js";',
      "export let   addItem = async (ports: Ports, sku: string): Promise<void> => {",
      ...code.split("\n").slice(2),
    ]);
    expect(lines[10]).toContain('addItem = __bearing_trace.wrap(addItem, "addItem");');
    expect(lines[10]).toContain('count = __bearing_trace.wrap(count, "count");');
    expect(lines[10]).not.toContain("ambient");
  });
});

describe("instrumentCommonJs", () => {
  it("wraps the functions left on module.exports", async () => {
    const calls = stubRuntime();
    const module = await load("exports.cjs", "exports.double = (n) => n * 2;\nexports.limit = 10;\n");
    expect(module.double!(4)).toBe(8);
    expect(module.limit).toBe(10);
    expect(calls).toEqual(["basketService.double"]);
  });
});
