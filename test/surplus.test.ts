import { describe, expect, it } from "vitest";
import { exportedFunctions, formatSurplus } from "../src/surplus.js";

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
    expect(formatSurplus({ outside: [], untraced: [], traced: true })).toBe(
      "Surplus: passed, every source file is in a component and every exported function is reached by a tagged test\n",
    );
  });
});
