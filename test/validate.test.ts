import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadModel } from "../src/diff.js";
import { modelFromWorkspace, type Model } from "../src/model.js";
import { createProgram } from "../src/program.js";
import { criteriaPin, loadRequirements, type Requirement } from "../src/requirements.js";
import { StructurizrError } from "../src/structurizr.js";
import { validateModel } from "../src/validate.js";
import { basketDir } from "./basket.js";

// Converting the DSL needs Structurizr, so the command tests read the basket target from its exported JSON instead.
vi.mock("../src/diff.js", async (original) => ({ ...(await original()), loadModel: vi.fn() }));

const repo = join(basketDir, "repo");
const issuesFile = join(basketDir, "issues.json");
const config = loadConfig(repo);
// Exported by the pinned Structurizr from the basket repo's architecture/workspace.dsl.
const model = () =>
  modelFromWorkspace(JSON.parse(readFileSync(join(basketDir, "workspace.json"), "utf8")) as Record<string, unknown>);
const requirements = await loadRequirements(config, { issuesFile });

function requirement(number: number, fields: Partial<Requirement> = {}): Requirement {
  return {
    id: `#${number}`,
    number,
    title: `Story ${number}`,
    state: "open",
    stateReason: null,
    story: `As a shopper, I want story ${number}.`,
    criteria: [{ id: `#${number}/AC1`, number: 1, text: "Given a, when b, then c." }],
    parent: null,
    epic: false,
    ...fields,
  };
}

function close(number: number, stateReason: string): Requirement[] {
  return requirements.map((each) =>
    each.number === number ? { ...each, state: "closed" as const, stateReason } : each,
  );
}

function problems(target: Model, issues: Requirement[] = requirements) {
  return validateModel(target, issues).map(({ rule, id, message }) => ({ rule, id, message }));
}

describe("validateModel", () => {
  it("passes the basket target", () => {
    expect(validateModel(model(), requirements)).toEqual([]);
  });

  describe("requirements", () => {
    it("fails an element that lists no requirement", () => {
      const target = model();
      target.elements.get("sessionRestore")!.requirements = [];
      expect(problems(target)).toEqual([
        {
          rule: "requirements",
          id: "sessionRestore",
          message: expect.stringContaining('component serves no open requirement; set "bearing.requirements"'),
        },
      ]);
    });

    it("fails a relationship that lists no requirement", () => {
      const target = model();
      target.relationships.get("sessionRestore->basketRepository")!.requirements = [];
      expect(problems(target)).toEqual([
        {
          rule: "requirements",
          id: "sessionRestore->basketRepository",
          message: expect.stringMatching(/^relationship/),
        },
      ]);
    });

    it("lists for pruning what served only an issue closed as not planned, and its code", () => {
      const closed = close(4, "not_planned");
      const found = problems(model(), closed);
      // Session restore and its relationships served only #4.
      expect(found.filter((problem) => problem.message.includes("prune it"))).toEqual([
        {
          rule: "requirements",
          id: "sessionRestore",
          message:
            "component served only #4, closed as not planned; prune it from the target, and delete its code under src/basket-api/session-restore",
        },
        ...[
          "basketController->sessionRestore",
          "sessionRestore->authMiddleware",
          "sessionRestore->basketRepository",
        ].map((id) => ({
          rule: "requirements",
          id,
          message: "relationship served only #4, closed as not planned; prune it from the target",
        })),
        {
          rule: "dynamic-view",
          id: "req-4",
          message: "dynamic view is for #4, closed as not planned; prune it from the target",
        },
      ]);
    });

    it("fails an element that lists a closed issue next to open ones", () => {
      const found = problems(model(), close(4, "not_planned")).filter(
        (problem) => !problem.message.includes("prune it"),
      );
      expect(found.length).toBeGreaterThan(0);
      expect(found).toContainEqual({
        rule: "requirements",
        id: "basketController",
        message: '"bearing.requirements" lists #4, closed; drop it and keep #1, #2, #3, #6, #7',
      });
      for (const problem of found) expect(problem.message).toMatch(/lists #4, closed; drop it and keep #/);
    });

    it("fails an element that serves only an issue closed as completed", () => {
      const target = model();
      target.elements.get("basketService")!.requirements = ["#9"];
      const issues = [...requirements, requirement(9, { state: "closed", stateReason: "completed" })];
      expect(problems(target, issues)).toEqual([
        {
          rule: "requirements",
          id: "basketService",
          message: expect.stringContaining("component serves no open requirement"),
        },
      ]);
    });

    it("fails an issue that isn't a requirement, even next to one that is", () => {
      const target = model();
      target.elements.get("basketService")!.requirements = ["#1", "#99", "2"];
      expect(problems(target)).toEqual([
        {
          rule: "requirements",
          id: "basketService",
          message: expect.stringContaining('lists "#99", "2", which aren\'t requirements'),
        },
      ]);
    });

    it("ignores relationships between deployment nodes", () => {
      const target = model();
      expect([...target.relationships.values()].some((each) => each.id === "lb->ecs")).toBe(true);
      expect(problems(target)).toEqual([]);
    });
  });

  describe("paths", () => {
    it("fails a component with no bearing.path", () => {
      const target = model();
      delete target.elements.get("authMiddleware")!.path;
      expect(problems(target)).toEqual([
        { rule: "path", id: "authMiddleware", message: expect.stringContaining('component has no "bearing.path"') },
      ]);
    });

    it("fails paths that overlap, however they are written", () => {
      const target = model();
      target.elements.get("basketService")!.path = "./src/basket-api/basket-controller/service/";
      target.elements.get("sessionRestore")!.path = "src/basket-api/basket-repository";
      expect(problems(target)).toEqual([
        {
          rule: "path",
          id: "basketService",
          message:
            '"bearing.path" "src/basket-api/basket-controller/service" overlaps basketController\'s "src/basket-api/basket-controller"; no two components may own the same files',
        },
        { rule: "path", id: "sessionRestore", message: expect.stringContaining("overlaps basketRepository's") },
      ]);
    });

    it("doesn't count a shared prefix as an overlap", () => {
      const target = model();
      target.elements.get("basketService")!.path = "src/basket-api/basket-controller-helpers";
      expect(problems(target)).toEqual([]);
    });

    it("fails a path that owns the whole repo while others exist", () => {
      const target = model();
      target.elements.get("authMiddleware")!.path = ".";
      expect(problems(target).map((problem) => problem.id)).toEqual([
        "basketController",
        "basketService",
        "basketRepository",
        "sessionRestore",
      ]);
    });

    it("fails a path outside the repo", () => {
      const target = model();
      target.elements.get("authMiddleware")!.path = "../shared/auth";
      expect(problems(target)).toEqual([
        { rule: "path", id: "authMiddleware", message: expect.stringContaining("is outside the repo") },
      ]);
    });
  });

  describe("dynamic views", () => {
    it("fails an open story with no dynamic view", () => {
      expect(problems(model(), [...requirements, requirement(9, { title: "Keep a guest basket" })])).toEqual([
        {
          rule: "dynamic-view",
          id: "#9",
          message: 'open story has no dynamic view; add one keyed "req-9" and titled "#9 Keep a guest basket"',
        },
      ]);
    });

    it("needs no view for an epic or a closed story, but fails a view for an epic", () => {
      const issues = requirements.map((each) => (each.number === 4 ? { ...each, epic: true } : each));
      issues.push(requirement(9, { state: "closed", stateReason: "completed" }));
      expect(problems(model(), issues)).toEqual([
        { rule: "dynamic-view", id: "req-4", message: expect.stringContaining("#4, an epic; epics get none") },
      ]);
    });

    it("fails a view that isn't keyed to a requirement", () => {
      const target = model();
      const view = target.dynamicViews.get("req-2")!;
      target.dynamicViews.set("add-item", { ...view, id: "add-item" });
      target.dynamicViews.set("req-99", { ...view, id: "req-99" });
      expect(problems(target).map(({ id, message }) => `${id}: ${message}`)).toEqual([
        expect.stringMatching(/^add-item: dynamic view isn't keyed to a requirement/),
        "req-99: dynamic view is for #99, which isn't a requirement",
      ]);
    });
  });

  describe("criteria", () => {
    function edit(number: number, criteria: Requirement["criteria"]): Requirement[] {
      return requirements.map((each) => (each.number === number ? { ...each, criteria } : each));
    }
    const ac = (n: number, text: string) => ({ id: `#2/AC${n}`, number: n, text });
    const two = requirements.find((each) => each.number === 2)!;

    it("pins each criterion's text, ignoring how it wraps", () => {
      const rewrapped = edit(
        2,
        two.criteria.map((each) => ({ ...each, text: `  ${each.text.replace(/ /g, "\n   ")} ` })),
      );
      expect(criteriaPin(rewrapped.find((each) => each.number === 2)!)).toBe(criteriaPin(two));
      expect(criteriaPin(two)).toMatch(/^AC1:[0-9a-f]{8},AC2:[0-9a-f]{8}$/);
      expect(problems(model(), rewrapped)).toEqual([]);
    });

    it("flags the view and the tests of an edited criterion as stale", () => {
      const edited = edit(2, [
        two.criteria[0]!,
        ac(2, "Given a shopper, when they add an unknown SKU, then it is refused."),
      ]);
      const pin = criteriaPin(edited.find((each) => each.number === 2)!);
      expect(problems(model(), edited)).toEqual([
        {
          rule: "criteria",
          id: "req-2",
          message: `#2's criteria changed since the view was pinned (AC2 edited), so the view and the tests tagged #2/AC2 are stale; check them against the criteria, then set "bearing.criteria" to "${pin}"`,
        },
      ]);
    });

    it("flags added and removed criteria, naming tests in the configured tag", () => {
      const added = edit(2, [
        ...two.criteria,
        ac(3, "Given a full basket, when they add an item, then it is refused."),
      ]);
      expect(validateModel(model(), added, "[<issue>-<n>]").map((problem) => problem.message)).toEqual([
        expect.stringContaining("(AC3 added), so the view and the tests tagged [2-3] are stale"),
      ]);
      const removed = edit(2, [two.criteria[0]!]);
      expect(problems(model(), removed).map((problem) => problem.message)).toEqual([
        expect.stringContaining("(AC2 removed), so the view and the tests tagged #2/AC2 are stale"),
      ]);
    });

    it("fails a view with no pin or a pin Bearing didn't write, giving the pin to set", () => {
      const target = model();
      delete target.dynamicViews.get("req-1")!.criteria;
      target.dynamicViews.get("req-2")!.criteria += ",whatever";
      const pin = (number: number) => criteriaPin(requirements.find((each) => each.number === number)!);
      expect(problems(target)).toEqual([
        {
          rule: "criteria",
          id: "req-1",
          message: `dynamic view doesn't pin #1's criteria; once it and the tests tagged with them match the criteria, set "bearing.criteria" to "${pin(1)}"`,
        },
        {
          rule: "criteria",
          id: "req-2",
          message: `"bearing.criteria" "${pin(2)},whatever" isn't a pin Bearing writes; set it to "${pin(2)}"`,
        },
      ]);
    });
  });

  describe("steps", () => {
    it("fails a step along a relationship Structurizr implied", () => {
      const target = model();
      // Implied by webApp -> basketController, but never declared.
      target.dynamicViews.get("req-1")!.steps[0]!.destination = "basketApi";
      expect(problems(target)).toEqual([
        {
          rule: "step",
          id: "req-1",
          message: expect.stringContaining("step 1 webApp->basketApi follows no declared relationship"),
        },
      ]);
    });

    it("fails a step against the declared direction", () => {
      const target = model();
      const step = target.dynamicViews.get("req-4")!.steps[1]!;
      [step.source, step.destination] = [step.destination, step.source];
      expect(problems(target).map((problem) => problem.message)).toEqual([
        expect.stringContaining("step 2 sessionRestore->basketController follows no declared relationship"),
      ]);
    });
  });
});

describe("bearing validate", () => {
  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    vi.stubEnv("BEARING_ISSUES_FILE", issuesFile);
    vi.mocked(loadModel).mockResolvedValue(model());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function run(...args: string[]) {
    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((text) => ((stdout += String(text)), true));
    const program = createProgram();
    for (const command of [program, ...program.commands]) {
      command.exitOverride().configureOutput({ writeErr: (text) => (stderr += text) });
    }
    let exitCode = 0;
    try {
      await program.parseAsync(["validate", ...args], { from: "user" });
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      exitCode = error.exitCode;
    }
    return { stdout, stderr, exitCode };
  }

  function broken() {
    const target = model();
    target.elements.get("sessionRestore")!.requirements = [];
    delete target.elements.get("authMiddleware")!.path;
    return target;
  }

  it("passes the basket target", async () => {
    const result = await run();
    expect(result).toEqual({
      stdout: "architecture/workspace.dsl is valid: 12 elements and 6 open stories, each with its dynamic view\n",
      stderr: "",
      exitCode: 0,
    });
    expect(loadModel).toHaveBeenCalledWith(join(repo, "architecture", "workspace.dsl"), expect.any(Function));
  });

  it("lists every broken rule and exits non-zero", async () => {
    vi.mocked(loadModel).mockResolvedValue(broken());
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^error: architecture\/workspace.dsl breaks 2 Bearing rules:\n/);
    expect(result.stderr).toContain("  - sessionRestore: component serves no open requirement");
    expect(result.stderr).toContain('  - authMiddleware: component has no "bearing.path"');
  });

  it("prints the problems as JSON with --json", async () => {
    expect(JSON.parse((await run("--json")).stdout)).toEqual({ problems: [] });
    vi.mocked(loadModel).mockResolvedValue(broken());
    const result = await run("--json");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ problems: validateModel(broken(), requirements) });
  });

  it("reports Structurizr's validation errors", async () => {
    vi.mocked(loadModel).mockRejectedValue(
      new StructurizrError('The destination element "missing" does not exist', "architecture/workspace.dsl", 4),
    );
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'error: architecture/workspace.dsl:4: The destination element "missing" does not exist',
    );
  });
});
