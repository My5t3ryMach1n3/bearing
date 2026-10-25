import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadModel } from "../src/diff.js";
import { modelFromWorkspace, type Model } from "../src/model.js";
import { createProgram } from "../src/program.js";
import { loadRequirements, type Requirement } from "../src/requirements.js";
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

    it("fails an element whose requirements are all closed", () => {
      const closed = requirements.map((each) =>
        each.number === 4 ? { ...each, state: "closed" as const, stateReason: "not_planned" } : each,
      );
      const ids = problems(model(), closed)
        .filter((problem) => problem.rule === "requirements")
        .map((problem) => problem.id);
      // Session restore and its relationships served only #4.
      expect(ids).toEqual([
        "sessionRestore",
        "basketController->sessionRestore",
        "sessionRestore->authMiddleware",
        "sessionRestore->basketRepository",
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
