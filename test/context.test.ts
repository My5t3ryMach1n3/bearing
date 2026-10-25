import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { designContext, formatDesignContext, formatIssueContext, issueContext } from "../src/context.js";
import { loadModel } from "../src/diff.js";
import { modelFromWorkspace } from "../src/model.js";
import { createProgram } from "../src/program.js";
import { loadRequirements, RequirementsError, type Requirement } from "../src/requirements.js";
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

describe("designContext", () => {
  it("lists only open requirements", () => {
    const closed = requirement(5, { state: "closed", stateReason: "not_planned" });
    const context = designContext(config, [...requirements, closed]);
    expect(context.requirements.map((each) => each.id)).toEqual(["#1", "#2", "#3", "#4", "#6", "#7"]);
  });

  it("prints every open story with its criteria, then the rules", () => {
    const text = formatDesignContext(designContext(config, requirements));
    expect(text).toMatch(/^Open requirements: 6 stories, each needing one dynamic view\n/);
    expect(text).toContain(
      "#4 Restore the basket after the session expires\n" +
        "  As a shopper, I want my basket restored after my session expires, so that I don't lose it.\n" +
        "  #4/AC1 Given an expired session, when they return and sign in, then their saved basket is restored.\n",
    );
    for (const heading of ["C4 rules", "Bearing rules", "DSL conventions", "Example"]) {
      expect(text).toContain(`\n${heading}`);
    }
    expect(text).toContain("The model is architecture/workspace.dsl");
    expect(text).toContain('dynamic basketApi "req-2" "#2 Add an item to the basket"');
  });

  it("groups stories under their epic, which needs no view of its own", () => {
    const text = formatDesignContext(
      designContext(config, [
        requirement(10, { title: "Checkout", epic: true, story: "", criteria: [] }),
        requirement(11, { parent: 10 }),
        requirement(12, { parent: 10 }),
      ]),
    );
    expect(text).toMatch(/^Open requirements: 2 stories/);
    expect(text).toContain("#10 Checkout (epic of #11, #12)\n\n#11 Story 11 (in epic #10)\n");
  });

  it("uses the configured test tag in its rules", () => {
    const tagged = parseConfig(
      'version: 1\nmodel: m.dsl\nlanguage: typescript\ntests:\n  tag: "[<issue>.<n>]"\n',
      repo,
    );
    expect(formatDesignContext(designContext(tagged, requirements))).toContain('tagged with it, e.g. "[2.1]"');
  });
});

describe("issueContext", () => {
  const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

  it("slices out the components, relationships and dynamic view of #2", () => {
    const context = issueContext(config, model(), requirements, 2);
    expect(context.requirement.title).toBe("Add an item to the basket");
    expect(context.tags).toEqual(["#2/AC1", "#2/AC2"]);
    expect(ids(context.components)).toEqual([
      "authMiddleware",
      "basketController",
      "basketService",
      "basketRepository",
    ]);
    expect(context.components.map((component) => component.path)).toContain("src/basket-api/basket-service");
    expect(ids(context.elements)).toContain("productCatalogue");
    expect(ids(context.relationships)).toContain("basketService->productCatalogue");
    expect(ids(context.relationships)).not.toContain("basketController->sessionRestore");
    expect(context.dynamicView?.id).toBe("req-2");
    expect(context.dynamicView?.steps).toHaveLength(7);
  });

  it("gives #4 session restore and not the basket service", () => {
    const context = issueContext(config, model(), requirements, 4);
    expect(ids(context.components)).toContain("sessionRestore");
    expect(ids(context.components)).not.toContain("basketService");
    expect(ids(context.relationships)).toEqual(expect.arrayContaining(["sessionRestore->basketRepository"]));
    expect(ids(context.elements)).not.toContain("productCatalogue");
  });

  it("includes what the dynamic view passes through even if it doesn't list the issue", () => {
    const target = model();
    target.elements.get("basketRepository")!.requirements = ["#1"];
    target.relationships.get("basketService->basketRepository")!.requirements = ["#1"];
    const context = issueContext(config, target, requirements, 2);
    expect(ids(context.components)).toContain("basketRepository");
    expect(ids(context.relationships)).toContain("basketService->basketRepository");
  });

  it("prints the slice as text", () => {
    const text = formatIssueContext(issueContext(config, model(), requirements, 2));
    expect(text).toMatch(/^#2 Add an item to the basket\n {2}As a shopper/);
    expect(text).toContain("  #2/AC2 Given a product that isn't in the catalogue");
    expect(text).toContain(
      "Dynamic view req-2 in basketApi: the path #2's tests must take\n  1. webApp -> basketController  POST /basket/items\n",
    );
    expect(text).toContain(
      "Components (keep #2's code inside these paths)\n  authMiddleware  src/basket-api/auth-middleware\n",
    );
    expect(text).toContain("  basketRepository -> database  Reads from and writes to [SQL]\n");
  });

  it("says when the target has no dynamic view for the issue", () => {
    const text = formatIssueContext(issueContext(config, model(), [...requirements, requirement(9)], 9));
    expect(text).toContain('The target has no "req-9" view, so it doesn\'t cover #9 yet');
    expect(text).toContain("Components (keep #9's code inside these paths)\n  None.\n");
  });

  it("points an epic at its open stories", () => {
    const epic = [
      requirement(10, { title: "Checkout", epic: true, story: "", criteria: [] }),
      requirement(11, { parent: 10 }),
      requirement(12, { parent: 10, state: "closed", stateReason: "completed" }),
    ];
    const text = formatIssueContext(issueContext(config, model(), epic, 10));
    expect(text).toContain("Open stories: #11. Run `bearing context #<n>` for each.");
    expect(text).not.toContain("Components");
  });

  it("rejects an issue that isn't a requirement", () => {
    expect(() => issueContext(config, model(), requirements, 99)).toThrow(RequirementsError);
    expect(() => issueContext(config, model(), requirements, 99)).toThrow(/#99 is not a requirement/);
  });
});

describe("bearing context", () => {
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
      await program.parseAsync(["context", ...args], { from: "user" });
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      exitCode = error.exitCode;
    }
    return { stdout, stderr, exitCode };
  }

  it("prints the design context with --issues", async () => {
    const result = await run("--issues");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(formatDesignContext(designContext(config, requirements)));
  });

  it("prints an issue's slice, with or without the #", async () => {
    const expected = formatIssueContext(issueContext(config, model(), requirements, 2));
    expect((await run("#2")).stdout).toBe(expected);
    expect((await run("2")).stdout).toBe(expected);
    expect(loadModel).toHaveBeenCalledWith(join(repo, "architecture", "workspace.dsl"), expect.any(Function));
  });

  it("prints JSON with --json", async () => {
    expect(JSON.parse((await run("--issues", "--json")).stdout)).toEqual(
      JSON.parse(JSON.stringify(designContext(config, requirements))),
    );
    expect(JSON.parse((await run("4", "--json")).stdout)).toEqual(
      JSON.parse(JSON.stringify(issueContext(config, model(), requirements, 4))),
    );
  });

  it("needs exactly one of --issues and an issue", async () => {
    for (const args of [[], ["--issues", "2"]]) {
      const result = await run(...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("give either --issues or an issue number");
    }
  });

  it("fails on something that isn't an issue number", async () => {
    const result = await run("basket");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"basket" is not an issue number');
  });

  it("fails on an issue that isn't a requirement", async () => {
    const result = await run("99");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("#99 is not a requirement");
  });
});
