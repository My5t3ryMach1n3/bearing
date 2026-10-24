import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffModels } from "../src/diff.js";
import { modelFromWorkspace } from "../src/model.js";
import { createProgram } from "../src/program.js";

// Exported by the pinned Structurizr from test/fixtures/diff/{before,after}/workspace.dsl.
const fixture = (name: string) => new URL(`fixtures/diff/${name}`, import.meta.url).pathname;
const load = (name: string) =>
  modelFromWorkspace(JSON.parse(readFileSync(fixture(name), "utf8")) as Record<string, unknown>);

describe("diffModels", () => {
  const diff = diffModels(load("before.json"), load("after.json"));

  it("finds nothing between a model and itself", () => {
    expect(diffModels(load("before.json"), load("before.json"))).toEqual({
      elements: { added: [], removed: [], drifted: [] },
      relationships: { added: [], removed: [], drifted: [] },
      dynamicViews: { added: [], removed: [], drifted: [] },
      deployment: { added: [], removed: [], drifted: [] },
    });
  });

  it("reports a changed description as drift, not as a removed element", () => {
    expect(diff.elements.removed.map((element) => element.id)).toEqual(["email"]);
    expect(diff.elements.drifted).toEqual([
      {
        id: "basketService",
        changes: [
          {
            field: "description",
            from: "Adds, removes and persists basket items",
            to: "Adds, removes, prices and persists basket items",
          },
          { field: "requirements", from: ["#1", "#2", "#4"], to: ["#1", "#2", "#4", "#9"] },
        ],
      },
    ]);
  });

  it("reports added elements whole", () => {
    expect(diff.elements.added).toEqual([
      {
        id: "pricing",
        type: "component",
        name: "Pricing",
        description: "",
        technology: "",
        tags: [],
        parent: "basketApi",
        path: "src/basket-api/pricing",
        requirements: [],
        properties: {},
      },
    ]);
  });

  it("reports added, removed and drifted relationships", () => {
    expect(diff.relationships.added.map((relationship) => relationship.id)).toEqual([
      "basketController->basketRepository",
    ]);
    expect(diff.relationships.removed.map((relationship) => relationship.id)).toEqual(["basketService->email"]);
    expect(diff.relationships.drifted).toEqual([
      { id: "webApp->basketController", changes: [{ field: "technology", from: "HTTPS", to: "HTTP/2" }] },
    ]);
  });

  it("reports a changed step as drift in the dynamic view", () => {
    expect(diff.dynamicViews.drifted).toHaveLength(1);
    const [drift] = diff.dynamicViews.drifted;
    expect(drift?.id).toBe("req-2");
    expect(drift?.changes.map((change) => change.field)).toEqual(["steps"]);
    expect(drift?.changes[0]?.to).toContainEqual({
      order: "3",
      source: "basketService",
      destination: "basketRepository",
      description: "upsert()",
    });
  });

  it("reports drifted deployment nodes", () => {
    expect(diff.deployment).toEqual({
      added: [],
      removed: [],
      drifted: [{ id: "ecs", changes: [{ field: "technology", from: "Fargate", to: "EC2" }] }],
    });
  });

  it("leaves out a field's side when it is unset there", () => {
    const before = load("before.json");
    const after = load("before.json");
    delete after.elements.get("basketController")!.path;
    after.elements.get("basketRepository")!.path = "src/basket-api/basket-repository";
    expect(diffModels(before, after).elements.drifted).toEqual([
      { id: "basketController", changes: [{ field: "path", from: "src/basket-api/basket-controller" }] },
      { id: "basketRepository", changes: [{ field: "path", to: "src/basket-api/basket-repository" }] },
    ]);
  });
});

describe("bearing diff", () => {
  afterEach(() => vi.restoreAllMocks());

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
      await program.parseAsync(["diff", ...args], { from: "user" });
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      exitCode = error.exitCode;
    }
    return { stdout, stderr, exitCode };
  }

  it("prints the diff of two workspace JSON files as JSON", async () => {
    const result = await run(fixture("before.json"), fixture("after.json"));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(diffModels(load("before.json"), load("after.json")));
  });

  it("fails when a model file is missing", async () => {
    const result = await run(fixture("before.json"), "missing.json");
    expect(result).toMatchObject({ stdout: "", exitCode: 1 });
    expect(result.stderr).toContain("missing.json not found");
  });

  it("fails on a file that isn't JSON", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "bearing-diff-")), "workspace.json");
    writeFileSync(file, "workspace {}\n");
    const result = await run(fixture("before.json"), file);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not valid workspace JSON");
  });
});
