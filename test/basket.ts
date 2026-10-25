import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tracesDir } from "../src/test.js";
import type { TestRecord } from "../src/trace/runtime.js";

export const basketDir = join(import.meta.dirname, "fixtures", "basket");

// The seeded broken branches, each an overlay on the clean repo. See test/fixtures/basket/README.md.
export const basketVariants = [
  "controller-imports-repository",
  "redis-node",
  "untraced-helper",
  "wrong-place",
] as const;
export type BasketVariant = (typeof basketVariants)[number];

// Copies the basket repo to a temp directory, with a variant's files laid over it, and returns the copy's root.
// The copy borrows Bearing's node_modules, so its own scripts run without an install.
export function copyBasket(variant?: BasketVariant): string {
  const root = mkdtempSync(join(tmpdir(), `bearing-basket-${variant ?? "main"}-`));
  cpSync(join(basketDir, "repo"), root, { recursive: true });
  if (variant !== undefined) cpSync(join(basketDir, "variants", variant), root, { recursive: true });
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(root, "node_modules"), "junction");
  return root;
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

// The basket repo as a git repo with main committed, reading its target from the exported workspace JSON so
// no test runs Structurizr.
export function basketRepo(): string {
  const root = copyBasket();
  cpSync(join(basketDir, "workspace.json"), join(root, "architecture", "workspace.json"));
  const config = join(root, ".bearing", "config.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("workspace.dsl", "workspace.json"));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "main");
  return root;
}

export const passed = (criterion: string): TestRecord => ({
  name: `${criterion} works`,
  file: "test/integration/basket.test.ts",
  status: "passed",
  criterion,
});

export function record(root: string, ...tests: TestRecord[]) {
  mkdirSync(join(root, tracesDir), { recursive: true });
  writeFileSync(join(root, tracesDir, "tests-1-0.jsonl"), tests.map((test) => `${JSON.stringify(test)}\n`).join(""));
}

// A call into a component, "<component>.<function>", with the calls it makes.
export type Call = [string, ...Call[]];

// The basket's components each keep their functions in their folder's index.ts: basketService is
// src/basket-api/basket-service/index.ts.
const fileOf = (component: string) =>
  `src/basket-api/${component.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}/index.ts`;

// Writes the spans a test's calls would leave, as `bearing test` does. The real traces are checked in trace.test.ts.
export function trace(root: string, test: TestRecord, ...calls: Call[]) {
  const spans: object[] = [];
  const traceId = test.criterion!.replace(/\W/g, "").padStart(32, "0");
  const add = ([call, ...children]: Call, parentSpanId?: string) => {
    const [component, name] = call.split(".");
    const spanId = (spans.length + 1).toString(16).padStart(16, "0");
    spans.push({
      traceId,
      spanId,
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      name,
      startTimeUnixNano: String(spans.length),
      attributes: [
        { key: "bearing.component", value: { stringValue: component } },
        { key: "code.file.path", value: { stringValue: fileOf(component!) } },
        { key: "bearing.test", value: { stringValue: test.name } },
        { key: "bearing.criterion", value: { stringValue: test.criterion } },
      ],
    });
    for (const child of children) add(child, spanId);
  };
  for (const call of calls) add(call);
  const request = { resourceSpans: [{ scopeSpans: [{ spans }] }] };
  appendFileSync(
    join(root, tracesDir, `spans-${test.criterion!.replace(/\W/g, "")}-0.jsonl`),
    `${JSON.stringify(request)}\n`,
  );
}

// Adding an item along #2's dynamic view, and along session restore as wrong-place does.
export const addItem: Call = [
  "basketController.handle",
  ["authMiddleware.authenticate"],
  ["basketService.addItem", ["basketRepository.loadBasket"], ["basketRepository.saveBasket"]],
];
export const addItemInSessionRestore: Call = [
  "basketController.handle",
  ["authMiddleware.authenticate"],
  ["sessionRestore.addItem", ["basketRepository.loadBasket"], ["basketRepository.saveBasket"]],
];

// The basket repo with a variant committed on a branch of its name, and every criterion of #2 covered by a test
// that adds an item the way the variant does.
export function variantRepo(variant: BasketVariant): string {
  const root = basketRepo();
  git(root, "checkout", "-q", "-b", variant);
  cpSync(join(basketDir, "variants", variant), root, { recursive: true });
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", variant);
  const tests = [passed("#2/AC1"), passed("#2/AC2")];
  record(root, ...tests);
  for (const test of tests) trace(root, test, variant === "wrong-place" ? addItemInSessionRestore : addItem);
  return root;
}
