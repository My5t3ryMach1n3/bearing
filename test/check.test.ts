import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBoundaries, checkClaim, formatReport, runChecks, type CheckReport } from "../src/check.js";
import type { Claim } from "../src/claims.js";
import { loadConfig } from "../src/config.js";
import type { ImportGraph } from "../src/derive.js";
import { modelFromWorkspace } from "../src/model.js";
import { createProgram } from "../src/program.js";
import { tracesDir } from "../src/test.js";
import type { TestRecord } from "../src/trace/runtime.js";
import { basketDir, basketRepo, git, type BasketVariant } from "./basket.js";

const issuesFile = join(basketDir, "issues.json");
const target = modelFromWorkspace(JSON.parse(readFileSync(join(basketDir, "workspace.json"), "utf8")));

const passed = (criterion: string): TestRecord => ({
  name: `${criterion} works`,
  file: "test/integration/basket.test.ts",
  status: "passed",
  criterion,
});

function record(root: string, ...tests: TestRecord[]) {
  mkdirSync(join(root, tracesDir), { recursive: true });
  writeFileSync(join(root, tracesDir, "tests-1-0.jsonl"), tests.map((test) => `${JSON.stringify(test)}\n`).join(""));
}

// A call into a component, "<component>.<function>", with the calls it makes.
type Call = [string, ...Call[]];

// The basket's components each keep their functions in their folder's index.ts: basketService is
// src/basket-api/basket-service/index.ts.
const fileOf = (component: string) =>
  `src/basket-api/${component.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}/index.ts`;

// Writes the spans a test's calls would leave, as `bearing test` does. The real traces are checked in trace.test.ts.
function trace(root: string, test: TestRecord, ...calls: Call[]) {
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
const addItem: Call = [
  "basketController.handle",
  ["authMiddleware.authenticate"],
  ["basketService.addItem", ["basketRepository.loadBasket"], ["basketRepository.saveBasket"]],
];
const addItemInSessionRestore: Call = [
  "basketController.handle",
  ["authMiddleware.authenticate"],
  ["sessionRestore.addItem", ["basketRepository.loadBasket"], ["basketRepository.saveBasket"]],
];

// The basket repo with a variant committed on a branch of its name, and every criterion of #2 covered by a test
// that adds an item the way the variant does.
function variantRepo(variant: BasketVariant): string {
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

const statuses = (report: CheckReport) => Object.fromEntries(report.checks.map((check) => [check.check, check.status]));

beforeEach(() => vi.stubEnv("BEARING_ISSUES_FILE", issuesFile));
afterEach(() => vi.unstubAllEnvs());

describe("runChecks on the basket fixture", () => {
  // Each seeded branch fails the checks its README names, and only those. Surplus is advisory, so untraced-helper
  // passes them all. These traces only add an item, so Surplus flags every other function; trace.test.ts checks it
  // against real ones.
  it.each([
    [
      "controller-imports-repository",
      {
        claim: "failed",
        boundaries: "failed",
        deployment: "passed",
        coverage: "passed",
        paths: "passed",
        surplus: "flagged",
      },
    ],
    [
      "redis-node",
      {
        claim: "skipped",
        boundaries: "passed",
        deployment: "failed",
        coverage: "skipped",
        paths: "skipped",
        surplus: "flagged",
      },
    ],
    [
      "untraced-helper",
      {
        claim: "passed",
        boundaries: "passed",
        deployment: "passed",
        coverage: "passed",
        paths: "passed",
        surplus: "flagged",
      },
    ],
    [
      "wrong-place",
      {
        claim: "passed",
        boundaries: "passed",
        deployment: "passed",
        coverage: "passed",
        paths: "failed",
        surplus: "flagged",
      },
    ],
  ] as const)("%s", async (variant, expected) => {
    const report = await runChecks(loadConfig(variantRepo(variant)));
    expect(statuses(report)).toEqual(expected);
    expect(report.passed).toBe(!Object.values(expected).includes("failed"));
  });

  it("passes main, with nothing to claim or cover", async () => {
    const report = await runChecks(loadConfig(basketRepo()));
    expect(statuses(report)).toEqual({
      claim: "skipped",
      boundaries: "passed",
      deployment: "passed",
      coverage: "skipped",
      paths: "skipped",
      surplus: "passed",
    });
    expect(report.passed).toBe(true);
  });

  it("lists the undeclared relationship and the claim's mismatch for controller-imports-repository", async () => {
    const report = await runChecks(loadConfig(variantRepo("controller-imports-repository")));
    const [claim, boundaries] = report.checks;
    const imports = [
      {
        file: "src/basket-api/basket-controller/index.ts",
        line: expect.any(Number),
        module: "../basket-repository/index.js",
      },
    ];
    expect(claim).toMatchObject({
      file: ".bearing/claims/controller-imports-repository.yaml",
      mismatches: [{ kind: "unclaimed", id: "basketController->basketRepository", imports }],
    });
    expect(boundaries.undeclared).toEqual([
      expect.objectContaining({ id: "basketController->basketRepository", imports }),
    ]);
    const text = formatReport(report);
    expect(text).toContain(
      "Claim: failed, .bearing/claims/controller-imports-repository.yaml doesn't match the code\n" +
        "  basketController->basketRepository: the code makes it, but the target didn't have it and the claim doesn't add it\n",
    );
    expect(text).toContain("Boundaries: failed, the code makes relationships the target doesn't declare\n");
    expect(text).toMatch(/2 blocking checks failed: Claim, Boundaries\. Advisory, not blocking: Surplus flagged\.\n$/);
  });

  it("lists the Redis node for redis-node", async () => {
    const report = await runChecks(loadConfig(variantRepo("redis-node")));
    const deployment = report.checks[2];
    expect(deployment).toMatchObject({
      environment: "Production",
      added: [
        {
          id: "aws_elasticache_cluster.basket",
          technology: "Amazon ElastiCache",
          resource: { address: "aws_elasticache_cluster.basket", file: "infra/cache.tf" },
        },
      ],
      removed: [],
      drifted: [],
    });
    expect(formatReport(report)).toContain(
      "Deployment: failed, the Terraform doesn't match the target's Production deployment\n" +
        "  aws_elasticache_cluster.basket: Amazon ElastiCache in the Terraform, but not in the target (infra/cache.tf:",
    );
  });

  it("shows #2's expected path beside the one wrong-place takes", async () => {
    const report = await runChecks(loadConfig(variantRepo("wrong-place")));
    const paths = report.checks[4];
    expect(paths).toMatchObject({ issues: ["#2"], views: [{ issue: "#2", view: "req-2", status: "failed" }] });
    const text = formatReport(report);
    expect(text).toContain(
      "Trace paths: failed, 2 of 2 tagged tests don't follow their issue's dynamic view\n" +
        "  #2/AC1 works (test/integration/basket.test.ts)\n" +
        "    Expected (req-2)                    Observed\n" +
        "                                        (test) -> basketController: handle()\n" +
        "    basketController -> authMiddleware  basketController -> authMiddleware: authenticate()\n" +
        "                                        basketController -> sessionRestore: addItem()  <- sessionRestore isn't in req-2\n" +
        "                                        sessionRestore -> basketRepository: loadBasket(), saveBasket()  <- sessionRestore isn't in req-2\n" +
        "    basketController -> basketService   missing\n" +
        "    basketService -> basketRepository   missing\n",
    );
    expect(text).toMatch(/1 blocking check failed: Trace paths\. Advisory, not blocking: Surplus flagged\.\n$/);
  });

  it("checks the issues given instead of the claim's", async () => {
    const report = await runChecks(loadConfig(variantRepo("untraced-helper")), { issues: [7] });
    expect(report.checks[3]).toMatchObject({ status: "failed", issues: ["#7"], criteria: [{ status: "missing" }] });
  });

  it("takes the issues from the branch name when there's no claims file", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "issue-7-session-expiry");
    record(root, passed("#7/AC1"));
    const report = await runChecks(loadConfig(root));
    expect(report.checks[3]).toMatchObject({ status: "passed", issues: ["#7"] });
  });

  it("skips Deployment when there's no Terraform to read", async () => {
    const root = basketRepo();
    const config = loadConfig(root);
    delete config.iac.terraform;
    const report = await runChecks(config);
    expect(report.checks[2]).toMatchObject({ status: "skipped", reason: expect.stringContaining("iac.terraform") });
  });

  it("flags a file outside every component, without blocking", async () => {
    const root = basketRepo();
    writeFileSync(join(root, "src", "server.ts"), "export const port = 3000;\n");
    const report = await runChecks(loadConfig(root));
    expect(report.checks[5]).toMatchObject({
      status: "flagged",
      outside: ["src/server.ts"],
      untraced: [],
      traced: false,
    });
    expect(report.passed).toBe(true);
    expect(formatReport(report)).toContain(
      "Surplus: flagged (advisory, doesn't block merge), code that may not be needed\n" +
        "  Outside every component's path:\n" +
        "    src/server.ts\n" +
        "  Untraced functions not looked for: no tagged test's trace is recorded; run `bearing test`.\n",
    );
  });

  it("skips Surplus when it's turned off", async () => {
    const config = loadConfig(variantRepo("untraced-helper"));
    config.checks.surplus = "off";
    const report = await runChecks(config);
    expect(report.checks[5]).toMatchObject({ status: "skipped", reason: expect.stringContaining("checks.surplus") });
    expect(formatReport(report)).toMatch(/All blocking checks passed\.\n$/);
  });
});

// The basket's import graph on main, less the files; only relationships and ownership matter here.
function graph(relationships: Array<[string, string]>, components: Record<string, string[]> = {}): ImportGraph {
  return {
    components: Object.entries(components).map(([id, files]) => ({ id, path: target.elements.get(id)!.path!, files })),
    relationships: relationships.map(([source, destination]) => ({
      id: `${source}->${destination}`,
      source,
      destination,
      imports: [{ file: "src/x.ts", line: 1, module: "./y.js" }],
    })),
    unmapped: [],
  };
}

const claim = (overrides: Partial<Claim> = {}): Claim => ({
  branch: "b",
  issues: ["#2"],
  model: { added: [], removed: [] },
  files: [],
  note: "",
  ...overrides,
});

describe("checkClaim", () => {
  const inputs = (built: ImportGraph, changed: string[] = []) => ({ forked: target, target, graph: built, changed });

  it("passes relationships the target had at the fork point", () => {
    expect(checkClaim(claim(), inputs(graph([["basketController", "basketService"]])))).toEqual([]);
  });

  it("passes a new relationship the claim adds, with or without a description", () => {
    const built = graph([["basketController", "basketRepository"]]);
    expect(
      checkClaim(claim({ model: { added: ["basketController->basketRepository"], removed: [] } }), inputs(built)),
    ).toEqual([]);
    expect(
      checkClaim(
        claim({ model: { added: ["basketController->basketRepository[Saves]"], removed: [] } }),
        inputs(built),
      ),
    ).toEqual([]);
  });

  it("fails a new relationship the claim doesn't add", () => {
    expect(checkClaim(claim(), inputs(graph([["basketController", "basketRepository"]])))).toEqual([
      expect.objectContaining({ kind: "unclaimed", id: "basketController->basketRepository" }),
    ]);
  });

  it("fails a relationship the claim removes that the code still makes", () => {
    const removes = claim({ model: { added: [], removed: ["basketController->basketService"] } });
    expect(checkClaim(removes, inputs(graph([["basketController", "basketService"]])))).toEqual([
      expect.objectContaining({ kind: "not-removed", id: "basketController->basketService" }),
    ]);
  });

  it("fails a component the claim removes that still has files under its path", () => {
    const path = target.elements.get("sessionRestore")!.path!;
    const built = { ...graph([]), unmapped: [`${path}/index.ts`] };
    expect(checkClaim(claim({ model: { added: [], removed: ["sessionRestore"] } }), inputs(built))).toEqual([
      { kind: "not-removed", id: "sessionRestore", files: [`${path}/index.ts`] },
    ]);
  });

  it("doesn't fail an addition the code doesn't make yet", () => {
    const adds = claim({ model: { added: ["sessionRestore->basketService"], removed: [] } });
    expect(checkClaim(adds, inputs(graph([])))).toEqual([]);
  });

  it("checks the files against what the branch changes and the components that own them", () => {
    const service = "src/basket-api/basket-service/addItem.ts";
    const controller = "src/basket-api/basket-controller/index.ts";
    const files = [
      { path: service, component: "basketController" },
      { path: "src/basket-api/basket-repository/index.ts", component: "basketRepository" },
    ];
    expect(checkClaim(claim({ files }), inputs(graph([]), [controller, service, "src/server.ts"]))).toEqual([
      { kind: "unlisted-file", path: controller, component: "basketController" },
      { kind: "wrong-component", path: service, claimed: "basketController", component: "basketService" },
      { kind: "unlisted-file", path: "src/server.ts" },
      { kind: "unchanged-file", path: "src/basket-api/basket-repository/index.ts" },
    ]);
  });
});

describe("checkBoundaries", () => {
  it("fails only relationships between components that the target doesn't declare", () => {
    const built = graph([
      ["basketController", "basketService"],
      ["basketController", "basketRepository"],
    ]);
    expect(checkBoundaries(target, built).map((relationship) => relationship.id)).toEqual([
      "basketController->basketRepository",
    ]);
  });
});

describe("bearing check", () => {
  let root: string;
  beforeEach(() => {
    root = variantRepo("untraced-helper");
    vi.spyOn(process, "cwd").mockReturnValue(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function run(...args: string[]) {
    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((text) => ((stdout += String(text)), true));
    const program = createProgram();
    for (const command of [program, ...program.commands]) {
      command.exitOverride().configureOutput({ writeErr: (text) => (stderr += text) });
    }
    let exitCode: number;
    try {
      await program.parseAsync(["check", ...args], { from: "user" });
      exitCode = Number(process.exitCode ?? 0);
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      exitCode = error.exitCode;
    }
    return { stdout, stderr, exitCode };
  }

  it("passes when every check passes", async () => {
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claim: passed, .bearing/claims/untraced-helper.yaml matches the code\n");
    expect(result.stdout).toContain("Criteria coverage: 2 of 2 criteria covered\n");
    expect(result.stdout).toContain(
      "Surplus: flagged (advisory, doesn't block merge), code that may not be needed\n" +
        "  Exported but never called by a test tagged with a criterion:\n",
    );
    expect(result.stdout).toContain(
      "    src/basket-api/basket-service/retryWithBackoff.ts (basketService): retryWithBackoff()\n",
    );
    expect(result.stdout).toMatch(/All blocking checks passed\. Advisory, not blocking: Surplus flagged\.\n$/);
  });

  it("exits non-zero when a check fails", async () => {
    const result = await run("2", "#7");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("#7/AC1  missing");
    expect(result.stdout).toMatch(
      /1 blocking check failed: Criteria coverage\. Advisory, not blocking: Surplus flagged\.\n$/,
    );
  });

  it("prints JSON with --json", async () => {
    const result = await run("--json");
    const report = JSON.parse(result.stdout) as CheckReport;
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => [check.check, check.status, check.blocking])).toEqual([
      ["claim", "passed", true],
      ["boundaries", "passed", true],
      ["deployment", "passed", true],
      ["coverage", "passed", true],
      ["paths", "passed", true],
      ["surplus", "flagged", false],
    ]);
  });

  it("fails on something that isn't an issue number", async () => {
    const result = await run("2", "basket");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"basket" is not an issue number');
  });

  it("fails on an issue that isn't a requirement", async () => {
    const result = await run("99");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("#99 is not a requirement");
  });
});
