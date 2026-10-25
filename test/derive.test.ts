import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { deriveImports, DeriveError, importModel } from "../src/derive.js";
import { diffModels } from "../src/diff.js";
import { modelFromWorkspace, type Element, type Model } from "../src/model.js";
import { basketDir, copyBasket } from "./basket.js";

const basketTarget = modelFromWorkspace(JSON.parse(readFileSync(join(basketDir, "workspace.json"), "utf8")));

// A target with one component per `id: path`, and nothing else.
function target(paths: Record<string, string>): Model {
  const elements = new Map<string, Element>();
  for (const [id, path] of Object.entries(paths)) {
    const component: Element = {
      id,
      type: "component",
      name: id,
      description: "",
      technology: "",
      tags: [],
      path,
      requirements: [],
      properties: {},
    };
    elements.set(id, component);
  }
  return { elements, relationships: new Map(), dynamicViews: new Map(), deployment: new Map() };
}

const tsconfig = {
  compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true },
  include: ["src", "test"],
};

// Writes a repo to a temp directory and returns its config.
function repo(files: Record<string, string>, compilerOptions: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "bearing-derive-"));
  const all = {
    "tsconfig.json": JSON.stringify({
      ...tsconfig,
      compilerOptions: { ...tsconfig.compilerOptions, ...compilerOptions },
    }),
    "package.json": JSON.stringify({ type: "module" }),
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return parseConfig("version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\n", root);
}

const ids = (graph: ReturnType<typeof deriveImports>) => graph.relationships.map((relationship) => relationship.id);

describe("deriveImports", () => {
  const components = target({ a: "src/a", b: "src/b", c: "src/c" });

  it("turns imports between components into relationships, with where each import is", () => {
    const config = repo({
      "src/a/index.ts":
        'import { b } from "../b/index.js";\nimport { c } from "../c/index.js";\nexport const a = b + c;\n',
      "src/b/index.ts": 'import { c } from "../c/index.js";\nexport const b = c;\n',
      "src/c/index.ts": "export const c = 1;\n",
    });
    const graph = deriveImports(config, components);
    expect(ids(graph)).toEqual(["a->b", "a->c", "b->c"]);
    expect(graph.relationships[0]).toEqual({
      id: "a->b",
      source: "a",
      destination: "b",
      imports: [{ file: "src/a/index.ts", line: 1, module: "../b/index.js" }],
    });
    expect(graph.components).toEqual([
      { id: "a", path: "src/a", files: ["src/a/index.ts"] },
      { id: "b", path: "src/b", files: ["src/b/index.ts"] },
      { id: "c", path: "src/c", files: ["src/c/index.ts"] },
    ]);
  });

  it("ignores imports inside one component", () => {
    const config = repo({
      "src/a/index.ts": 'export { helper } from "./helper.js";\nimport { helper } from "./helper.js";\nhelper();\n',
      "src/a/helper.ts": "export function helper() {}\n",
    });
    const graph = deriveImports(config, components);
    expect(graph.relationships).toEqual([]);
    expect(graph.components).toEqual([{ id: "a", path: "src/a", files: ["src/a/helper.ts", "src/a/index.ts"] }]);
  });

  it("resolves imports through tsconfig paths", () => {
    const config = repo(
      {
        "src/a/index.ts":
          'import { b } from "@app/b";\nimport type { C } from "#c/types.js";\nexport const a: C = b;\n',
        "src/b/index.ts": "export const b = 1;\n",
        "src/c/types.ts": "export type C = number;\n",
      },
      { paths: { "@app/*": ["./src/*/index.ts"], "#c/*": ["./src/c/*"] } },
    );
    expect(ids(deriveImports(config, components))).toEqual(["a->b", "a->c"]);
  });

  it("follows barrels and re-exports to the component that declares what is imported", () => {
    const config = repo({
      // A barrel outside every component, re-exporting b's code under another name.
      "src/index.ts": 'export { b as fromB } from "./b/index.js";\nexport * from "./c/index.js";\n',
      // c's own index re-exports a file inside c.
      "src/c/index.ts": 'export { c } from "./impl.js";\n',
      "src/c/impl.ts": "export const c = 1;\n",
      "src/b/index.ts": 'export { c as reexported } from "../c/index.js";\nexport const b = 1;\n',
      "src/a/index.ts":
        'import { fromB, c } from "../index.js";\nimport { reexported } from "../b/index.js";\n' +
        "export const a = fromB + c + reexported;\n",
    });
    const graph = deriveImports(config, components);
    // a takes `reexported` through b's index, but it is c's code: a depends on c, not b, for that import.
    expect(ids(graph)).toEqual(["a->b", "a->c", "b->c"]);
    expect(graph.relationships.find((relationship) => relationship.id === "a->b")!.imports).toEqual([
      { file: "src/a/index.ts", line: 1, module: "../index.js" },
    ]);
    expect(graph.relationships.find((relationship) => relationship.id === "a->c")!.imports).toEqual([
      { file: "src/a/index.ts", line: 1, module: "../index.js" },
      { file: "src/a/index.ts", line: 2, module: "../b/index.js" },
    ]);
    expect(graph.unmapped).toEqual(["src/index.ts"]);
  });

  it("counts type-only, namespace, side-effect, dynamic and require imports", () => {
    const config = repo({
      "src/a/types.ts": 'import type { B } from "../b/index.js";\nexport type A = B;\n',
      "src/a/namespace.ts": 'import * as c from "../c/index.js";\nexport const n = c.c;\n',
      "src/b/effect.ts": 'import "../a/types.js";\n',
      "src/b/lazy.ts": 'export const lazy = () => import("../c/index.js");\n',
      "src/c/types.ts": 'export type T = import("../b/index.js").B;\n',
      "src/c/legacy.cts": 'import a = require("../a/namespace.cjs");\nexport = a;\n',
      "src/a/namespace.cts": "export const n = 1;\n",
      "src/b/index.ts": "export type B = number;\n",
      "src/c/index.ts": "export const c = 1;\n",
    });
    expect(ids(deriveImports(config, components))).toEqual(["a->b", "a->c", "b->a", "b->c", "c->a", "c->b"]);
  });

  it("lists source files under no component, leaving out tests, declarations and packages", () => {
    const config = repo({
      "src/a/index.ts":
        'import { join } from "node:path";\nimport { util } from "../shared/util.js";\nexport const a = join(util);\n',
      "src/a/index.test.ts": 'import { b } from "../b/index.js";\n',
      "src/b/index.ts": "export const b = 1;\n",
      "src/shared/util.ts": 'export const util = "";\n',
      "src/server.ts": 'import { a } from "./a/index.js";\nconsole.log(a);\n',
      "src/globals.d.ts": "declare const VERSION: string;\n",
      "test/support/app.ts": 'import { a } from "../../src/a/index.js";\nexport const app = a;\n',
    });
    const graph = deriveImports(config, components);
    expect(graph.unmapped).toEqual(["src/server.ts", "src/shared/util.ts"]);
    expect(graph.relationships).toEqual([]);
  });

  it("explains a missing or broken tsconfig", () => {
    const config = repo({ "src/a/index.ts": "" });
    expect(() => deriveImports({ ...config, tsconfig: "missing.json" }, components)).toThrow(
      new DeriveError('missing.json not found; check "tsconfig" in .bearing/config.yaml'),
    );
    writeFileSync(join(config.root, "tsconfig.json"), '{ "compilerOptions": { "module": "nope" } }');
    expect(() => deriveImports(config, components)).toThrow(/tsconfig\.json: .*--module/);
  });

  it("gives the as-built model the components that own code and their relationships", () => {
    const config = repo({
      "src/a/index.ts": 'import { b } from "../b/index.js";\nexport const a = b;\n',
      "src/b/index.ts": "export const b = 1;\n",
    });
    const model = importModel(components, deriveImports(config, components));
    expect([...model.elements.keys()]).toEqual(["a", "b"]);
    expect([...model.relationships.values()]).toEqual([
      {
        id: "a->b",
        source: "a",
        destination: "b",
        description: "",
        technology: "",
        tags: [],
        requirements: [],
        properties: {},
      },
    ]);
  });

  it("runs on a 50,000-line repo in under 30 seconds", { timeout: 60_000 }, () => {
    // 20 components of 25 files, each file 100 lines and importing two files of the next component.
    const files: Record<string, string> = {};
    const paths: Record<string, string> = {};
    for (let component = 0; component < 20; component++) {
      paths[`c${component}`] = `src/c${component}`;
      for (let file = 0; file < 25; file++) {
        const next = `../c${(component + 1) % 20}`;
        const lines = [
          `import { f${(file + 1) % 25} } from "${next}/f${(file + 1) % 25}.js";`,
          `import type { T${(file + 2) % 25} } from "${next}/f${(file + 2) % 25}.js";`,
          `export type T${file} = { n: number };`,
          `export function f${file}(t: T${(file + 2) % 25}): number {`,
          ...Array.from(
            { length: 94 },
            (_, line) => `  if (t.n === ${line}) return f${(file + 1) % 25}.length + ${line};`,
          ),
          "  return 0;",
          "}",
        ];
        files[`src/c${component}/f${file}.ts`] = `${lines.join("\n")}\n`;
      }
    }
    expect(Object.values(files).join("").split("\n").length - 1).toBe(50_000);
    const config = repo(files);
    const started = performance.now();
    const graph = deriveImports(config, target(paths));
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(graph.relationships).toHaveLength(20);
  });
});

describe("deriveImports on the basket fixture", () => {
  const relationshipsOf = (model: Model) =>
    [...model.relationships.values()]
      .filter(({ source, destination }) =>
        [source, destination].every((id) => basketTarget.elements.get(id)?.type === "component"),
      )
      .map(({ id }) => id);

  it("derives exactly the target's relationships between components on main", () => {
    const graph = deriveImports(loadConfig(join(basketDir, "repo")), basketTarget);
    expect(ids(graph)).toEqual(relationshipsOf(basketTarget).sort());
    expect(graph.unmapped).toEqual([]);
    expect(graph.components.map(({ id }) => id)).toEqual([
      "authMiddleware",
      "basketController",
      "basketRepository",
      "basketService",
      "sessionRestore",
    ]);
  });

  it("finds the controller importing the repository, which the target doesn't declare", () => {
    const root = copyBasket("controller-imports-repository");
    const asBuilt = importModel(basketTarget, deriveImports(loadConfig(root), basketTarget));
    const added = diffModels(basketTarget, asBuilt).relationships.added.map(({ id }) => id);
    expect(added).toEqual(["basketController->basketRepository"]);
  });

  it.each(["redis-node", "untraced-helper", "wrong-place"] as const)("adds no relationship on %s", (variant) => {
    const graph = deriveImports(loadConfig(copyBasket(variant)), basketTarget);
    expect(ids(graph)).toEqual(relationshipsOf(basketTarget).sort());
  });
});
