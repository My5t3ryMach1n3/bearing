import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { readTestRecords } from "../src/coverage.js";
import { modelFromWorkspace } from "../src/model.js";
import { componentPaths } from "../src/paths.js";
import { runTraced, tracesDir } from "../src/test.js";
import { basketDir, copyBasket } from "./basket.js";

// The hook runs in the test command's own processes, so these tests preload a build of it rather than the source.
// It goes under node_modules so the build finds Bearing's dependencies.
const build = join(import.meta.dirname, "..", "node_modules", ".cache", "bearing-trace-test");
const hook = pathToFileURL(join(build, "trace", "register.js"));
const quiet = { hook, env: { NODE_OPTIONS: "" }, stdio: "ignore" } as const;

beforeAll(() => {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json", "--outDir", build], {
    cwd: join(import.meta.dirname, ".."),
    stdio: "pipe",
  });
}, 60_000);

const basketTarget = modelFromWorkspace(JSON.parse(readFileSync(join(basketDir, "workspace.json"), "utf8")));
const basketComponents = componentPaths(basketTarget);

interface Span {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string } }>;
}

function spansIn(root: string): Span[] {
  const dir = join(root, tracesDir);
  return readdirSync(dir)
    .filter((file) => file.startsWith("spans-"))
    .flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .trim()
        .split("\n")
        .flatMap((line) =>
          (
            JSON.parse(line) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> }
          ).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
        ),
    );
}

const attribute = (span: Span, key: string) => span.attributes.find((item) => item.key === key)?.value.stringValue;

// Each span as "<component>.<function>", indented under its parent, in the order the calls started.
function callTree(spans: Span[]): string[] {
  const sorted = [...spans].sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1));
  const byId = new Map(sorted.map((span) => [span.spanId, span]));
  const depth = (span: Span): number => {
    const parent = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
    return parent === undefined ? 0 : depth(parent) + 1;
  };
  return sorted.map((span) => `${"  ".repeat(depth(span))}${attribute(span, "bearing.component")}.${span.name}`);
}

const criterion = (spans: Span[], tag: string) => spans.filter((span) => attribute(span, "bearing.criterion") === tag);

describe("bearing test", () => {
  it.each(["forks", "threads"])(
    "traces the basket's integration tests under Vitest's %s pool, tagged with their criteria",
    { timeout: 60_000 },
    async (pool) => {
      const root = copyBasket();
      const config = loadConfig(root);
      const result = await runTraced(config, basketComponents, [`${config.tests.integration} --pool=${pool}`], quiet);
      expect(result.exitCode).toBe(0);
      expect(result.criteria).toEqual([
        "#1/AC1",
        "#1/AC2",
        "#2/AC1",
        "#2/AC2",
        "#3/AC1",
        "#3/AC2",
        "#4/AC1",
        "#4/AC2",
        "#6/AC1",
        "#6/AC2",
        "#7/AC1",
      ]);
      // #2's dynamic view: controller, then service, then repository. The second request reads the basket back.
      expect(callTree(criterion(spansIn(root), "#2/AC1"))).toEqual([
        "basketController.handle",
        "  authMiddleware.authenticate",
        "  basketService.addItem",
        "    basketService.isValidQuantity",
        "    basketRepository.loadBasket",
        "    basketRepository.saveBasket",
        "basketController.handle",
        "  authMiddleware.authenticate",
        "  basketService.getBasket",
        "    basketRepository.loadBasket",
      ]);
    },
  );

  it("shows the path a misplaced implementation really takes", { timeout: 60_000 }, async () => {
    const root = copyBasket("wrong-place");
    const config = loadConfig(root);
    await runTraced(config, basketComponents, [config.tests.integration!], quiet);
    // Adding goes controller, session restore, repository; reading the basket back still goes through the service.
    expect(callTree(criterion(spansIn(root), "#2/AC1")).slice(0, 5)).toEqual([
      "basketController.handle",
      "  authMiddleware.authenticate",
      "  sessionRestore.addItem",
      "    basketRepository.loadBasket",
      "    basketRepository.saveBasket",
    ]);
  });

  it("traces untagged tests without a criterion", { timeout: 60_000 }, async () => {
    const root = copyBasket();
    await runTraced(loadConfig(root), basketComponents, ["npx vitest run test/unit"], quiet);
    const spans = spansIn(root);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(attribute(span, "bearing.test")).toBe("accepts whole quantities from 1 to 99");
      expect(attribute(span, "bearing.criterion")).toBeUndefined();
    }
  });

  it("records how each test ended under Vitest, with its criterion", { timeout: 60_000 }, async () => {
    const root = copyBasket();
    writeFileSync(
      join(root, "test", "integration", "outcomes.test.ts"),
      [
        'import { describe, expect, it } from "vitest";',
        'describe("outcomes", () => {',
        '  it("#7/AC1 fails", () => expect(1).toBe(2));',
        '  it.skip("#7/AC1 is skipped", () => {});',
        "});",
      ].join("\n"),
    );
    const config = loadConfig(root);
    const result = await runTraced(config, basketComponents, [`${config.tests.integration!} test/unit`], quiet);
    expect(result.exitCode).toBe(1);
    const records = readTestRecords(join(root, tracesDir));
    expect(records).toHaveLength(14);
    expect(records).toContainEqual({
      name: "#2 Add an item to the basket > #2/AC1 keeps an added item across sessions",
      file: "test/integration/add-item.test.ts",
      status: "passed",
      criterion: "#2/AC1",
    });
    expect(records.filter((record) => record.file === "test/integration/outcomes.test.ts")).toEqual([
      {
        name: "outcomes > #7/AC1 fails",
        file: "test/integration/outcomes.test.ts",
        status: "failed",
        criterion: "#7/AC1",
      },
      {
        name: "outcomes > #7/AC1 is skipped",
        file: "test/integration/outcomes.test.ts",
        status: "skipped",
        criterion: "#7/AC1",
      },
    ]);
    expect(records.find((record) => record.file === "test/unit/quantity.test.ts")).toEqual({
      name: "accepts whole quantities from 1 to 99",
      file: "test/unit/quantity.test.ts",
      status: "passed",
    });
  });

  it("records how each test ended under Jest, with its criterion", { timeout: 60_000 }, async () => {
    const root = node({
      "package.json": '{ "private": true }\n',
      "src/maths/index.js": "exports.double = (n) => n * 2;\n",
      "test/maths.test.js": [
        'const { double } = require("../src/maths/index.js");',
        'describe("maths", () => {',
        '  test("#1/AC1 doubles", () => expect(double(2)).toBe(4));',
        '  test("#1/AC2 triples", () => expect(double(2)).toBe(6));',
        '  test.skip("#2/AC1 halves", () => {});',
        '  test("adds", () => expect(double(1)).toBe(2));',
        "});",
      ].join("\n"),
    });
    symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(root, "node_modules"), "junction");
    const config = parseConfig("version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\n", root);
    const result = await runTraced(config, [{ id: "maths", path: "src/maths" }], ["npx jest"], quiet);
    expect(result.exitCode).toBe(1);
    const file = "test/maths.test.js";
    expect(readTestRecords(join(root, tracesDir))).toEqual([
      { name: "maths #1/AC1 doubles", file, status: "passed", criterion: "#1/AC1" },
      { name: "maths #1/AC2 triples", file, status: "failed", criterion: "#1/AC2" },
      { name: "maths #2/AC1 halves", file, status: "skipped", criterion: "#2/AC1" },
      { name: "maths adds", file, status: "passed" },
    ]);
  });

  it("clears traces from the last run first", { timeout: 60_000 }, async () => {
    const root = copyBasket();
    mkdirSync(join(root, tracesDir), { recursive: true });
    writeFileSync(join(root, tracesDir, "spans-1-0.jsonl"), "stale\n");
    const result = await runTraced(loadConfig(root), basketComponents, ["node", "-e", ""], quiet);
    expect(result.spans).toBe(0);
    expect(readdirSync(join(root, tracesDir))).toEqual([]);
  });

  it("traces ES modules and CommonJS under plain Node", { timeout: 60_000 }, async () => {
    const root = node({
      "src/pricing/index.mjs": [
        'import { double } from "../maths/index.cjs";',
        "export function quadruple(n) { return double(double(n)); }",
        "export default async (n) => n / 2;",
      ].join("\n"),
      "src/maths/index.cjs": "exports.double = (n) => n * 2;\n",
      "main.mjs": 'import half, { quadruple } from "./src/pricing/index.mjs";\nquadruple(3);\nawait half(4);\n',
      "main.cjs": 'const { double } = require("./src/maths/index.cjs");\ndouble(1);\n',
    });
    const config = parseConfig("version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\n", root);
    const components = [
      { id: "pricing", path: "src/pricing" },
      { id: "maths", path: "src/maths" },
    ];
    await runTraced(config, components, ["node", "main.mjs"], quiet);
    expect(callTree(spansIn(root))).toEqual([
      "pricing.quadruple",
      "  maths.double",
      "  maths.double",
      "pricing.default",
    ]);
    await runTraced(config, components, ["node", "main.cjs"], quiet);
    expect(callTree(spansIn(root))).toEqual(["maths.double"]);
  });

  it.each([
    { format: "CommonJS", type: "commonjs", run: "npx jest", load: "require", exports: "exports.%s = " },
    {
      format: "ES modules",
      type: "module",
      run: "node --experimental-vm-modules node_modules/jest/bin/jest.js",
      load: "import",
      exports: "export const %s = ",
    },
  ])("traces Jest's tests in $format, tagged with their criteria", { timeout: 60_000 }, async (jest) => {
    const exported = (name: string, body: string) => `${jest.exports.replace("%s", name)}${body};\n`;
    const root = node({
      "package.json": JSON.stringify({ type: jest.type }),
      "src/pricing/index.js": [
        jest.load === "require"
          ? 'const { double } = require("../maths/index.js");\n'
          : 'import { double } from "../maths/index.js";\n',
        exported("quadruple", "(n) => double(double(n))"),
      ].join(""),
      "src/maths/index.js": exported("double", "(n) => n * 2"),
      "test/pricing.test.js": [
        jest.load === "require"
          ? 'const { quadruple } = require("../src/pricing/index.js");'
          : 'import { quadruple } from "../src/pricing/index.js";',
        'describe("pricing", () => {',
        '  test("#1/AC1 quadruples", () => expect(quadruple(1)).toBe(4));',
        '  test("quadruples zero", () => expect(quadruple(0)).toBe(0));',
        "});",
      ].join("\n"),
    });
    symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(root, "node_modules"), "junction");
    const config = parseConfig("version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\n", root);
    const components = [
      { id: "pricing", path: "src/pricing" },
      { id: "maths", path: "src/maths" },
    ];
    const result = await runTraced(config, components, [jest.run], quiet);
    expect(result.exitCode).toBe(0);
    expect(result.criteria).toEqual(["#1/AC1"]);
    const spans = spansIn(root);
    expect(callTree(criterion(spans, "#1/AC1"))).toEqual(["pricing.quadruple", "  maths.double", "  maths.double"]);
    expect(
      spans
        .filter((span) => attribute(span, "bearing.criterion") === undefined)
        .map((span) => attribute(span, "bearing.test")),
    ).toEqual(Array(3).fill("pricing quadruples zero"));
  });

  it("exits with the test command's exit code", { timeout: 60_000 }, async () => {
    const root = node({});
    const config = parseConfig("version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\n", root);
    const result = await runTraced(config, [], ["node", "-e", "process.exit(3)"], quiet);
    expect(result.exitCode).toBe(3);
  });
});

// Writes a plain Node repo to a temp directory and returns its root.
function node(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bearing-trace-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
