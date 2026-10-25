import { appendFileSync, cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { diffModels, loadModel } from "../src/diff.js";
import { init } from "../src/init.js";
import { modelFromWorkspace } from "../src/model.js";
import { loadWorkspace } from "../src/structurizr.js";
import { copyBasket } from "./basket.js";

// Runs the real Structurizr. Opt in with BEARING_STRUCTURIZR_RUNNER=docker or java; CI runs both.
const runner = process.env.BEARING_STRUCTURIZR_RUNNER;

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), "bearing-structurizr-"));
  cpSync(join(import.meta.dirname, "fixtures", name), join(root, "architecture"), { recursive: true });
  const text = `version: 1\nmodel: architecture/workspace.dsl\nstructurizr:\n  runner: ${runner}\nlanguage: typescript\n`;
  return parseConfig(text, root);
}

describe.runIf(runner === "docker" || runner === "java")(`loadWorkspace with ${runner}`, () => {
  it("converts the DSL, following includes", { timeout: 600_000 }, async () => {
    const config = fixture("include");
    // Warm the runner (image pull or .war download), then change the model so the timed call converts afresh.
    await loadWorkspace(config);
    appendFileSync(join(config.root, "architecture", "model.dsl"), `# ${Date.now()}\n`);
    const started = performance.now();
    const workspace = await loadWorkspace(config);
    console.log(`One Structurizr conversion with ${runner}: ${Math.round(performance.now() - started)} ms`);
    expect(workspace).toMatchObject({ name: "Basket", model: { people: [{ name: "Shopper" }] } });
  });

  it("converts the empty workspace `bearing init` writes", { timeout: 600_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "bearing-init-"));
    init(root, { owners: ["@acme"] });
    const text = readFileSync(join(root, ".bearing", "config.yaml"), "utf8").replace(
      "runner: docker",
      `runner: ${runner}`,
    );
    const workspace = await loadWorkspace(parseConfig(text, root));
    expect(workspace).toMatchObject({ name: expect.stringMatching(/^bearing-init-/), model: {} });
  });

  it("reports the file and line of a DSL error", { timeout: 600_000 }, async () => {
    const config = fixture("broken");
    await expect(loadWorkspace(config)).rejects.toMatchObject({
      file: "architecture/workspace.dsl",
      line: 4,
      message: expect.stringContaining('The destination element "missing" does not exist'),
    });
  });

  it("exports the diff fixtures as committed, so the diff of their DSL matches", { timeout: 600_000 }, async () => {
    const config = fixture("diff");
    const dsl = (side: string) => join(config.root, "architecture", side, "workspace.dsl");
    const json = (side: string) =>
      modelFromWorkspace(JSON.parse(readFileSync(join(config.root, "architecture", `${side}.json`), "utf8")));
    const before = await loadModel(dsl("before"), () => config);
    const after = await loadModel(dsl("after"), () => config);
    expect(before).toEqual(json("before"));
    expect(diffModels(before, after)).toEqual(diffModels(json("before"), json("after")));
  });

  it(
    "converts the basket fixture's target into a model whose dynamic views follow declared relationships",
    { timeout: 600_000 },
    async () => {
      const root = copyBasket();
      const config = parseConfig(
        readFileSync(join(root, ".bearing", "config.yaml"), "utf8").replace("runner: docker", `runner: ${runner}`),
        root,
      );
      const model = await loadModel(join(root, config.model), () => config);
      const components = [...model.elements.values()].filter((element) => element.type === "component");
      expect(components.filter((component) => component.path !== undefined)).toHaveLength(5);
      // Every element and relationship serves a requirement. Deployment relationships aren't required to yet.
      for (const element of model.elements.values()) expect(element.requirements, element.id).not.toHaveLength(0);
      for (const relationship of model.relationships.values()) {
        if (!model.elements.has(relationship.source)) continue;
        expect(relationship.properties["bearing.requirements"], relationship.id).toBeTruthy();
      }
      expect([...model.dynamicViews.keys()]).toEqual(["req-1", "req-2", "req-3", "req-4", "req-6", "req-7"]);
      for (const view of model.dynamicViews.values()) {
        for (const step of view.steps)
          expect(model.relationships.has(`${step.source}->${step.destination}`)).toBe(true);
      }
    },
  );
});
