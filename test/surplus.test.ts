import { describe, expect, it } from "vitest";
import type { Element, Model } from "../src/model.js";
import type { Requirement } from "../src/requirements.js";
import { closedComponents, exportedFunctions, formatSurplus } from "../src/surplus.js";

describe("exportedFunctions", () => {
  it("lists the functions the trace hook wraps, by exported name", () => {
    const code = [
      "export function a() {}",
      "export async function b() {}",
      "export const c = () => 1, d = function () {};",
      "function e() {}",
      "const f = () => 2;",
      "export { e, f as g };",
      "export default function () {}",
    ].join("\n");
    expect(exportedFunctions(code, "x.ts")).toEqual(["a", "b", "c", "d", "default", "e", "g"]);
  });

  it("leaves out classes, values, types, overloads, declarations and re-exports", () => {
    const code = [
      "export class A {}",
      "export const max = 99;",
      "export interface B {}",
      "export type C = () => void;",
      "export function d(x: string): string;",
      "export declare function e(): void;",
      'export { f } from "./f.js";',
      'export * from "./g.js";',
      "function h() {}",
    ].join("\n");
    expect(exportedFunctions(code, "x.ts")).toEqual([]);
  });

  it('names a default export of a local function or an expression "default"', () => {
    expect(exportedFunctions("function a() {}\nexport default a;", "x.ts")).toEqual(["default"]);
    expect(exportedFunctions("export default () => 1;", "x.ts")).toEqual(["default"]);
    expect(exportedFunctions("export default 1;", "x.ts")).toEqual([]);
  });
});

describe("formatSurplus", () => {
  it("passes when nothing is flagged", () => {
    expect(formatSurplus({ outside: [], closed: [], untraced: [], traced: true })).toBe(
      "Surplus: passed, every source file is in a component and every exported function is reached by a tagged test\n",
    );
  });

  it("lists the code of components that serve only closed requirements, to prune with them", () => {
    const closed = [
      { component: "sessionRestore", issues: ["#4"], files: ["src/basket-api/session-restore/index.ts"] },
    ];
    expect(formatSurplus({ outside: [], closed, untraced: [], traced: true })).toBe(
      [
        "Surplus: flagged (advisory, doesn't block merge), code that may not be needed",
        "  In components that serve only closed requirements, to prune with them:",
        "    sessionRestore (#4): src/basket-api/session-restore/index.ts",
        "  Remove the code if no requirement needs it, or tag a test that exercises it with the criterion it serves.",
        "",
      ].join("\n"),
    );
  });
});

describe("closedComponents", () => {
  const component = (id: string, requirements: string[]): [string, Element] => [
    id,
    { id, type: "component", name: id, description: "", technology: "", tags: [], requirements, properties: {} },
  ];
  const issue = (number: number, state: "open" | "closed"): Requirement => ({
    id: `#${number}`,
    number,
    title: "",
    state,
    stateReason: state === "open" ? null : "not_planned",
    story: "",
    criteria: [],
    parent: null,
    epic: false,
  });

  it("finds components that list closed requirements and no open one", () => {
    const target: Model = {
      elements: new Map([component("search", ["#5"]), component("loans", ["#2", "#5"]), component("stray", ["#99"])]),
      relationships: new Map(),
      dynamicViews: new Map(),
      deployment: new Map(),
    };
    expect(closedComponents(target, [issue(2, "open"), issue(5, "closed")])).toEqual(new Map([["search", ["#5"]]]));
  });
});
