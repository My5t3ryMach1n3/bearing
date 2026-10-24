import { appendFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { loadWorkspace } from "../src/structurizr.js";

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
    const config = fixture("basket");
    // Warm the runner (image pull or .war download), then change the model so the timed call converts afresh.
    await loadWorkspace(config);
    appendFileSync(join(config.root, "architecture", "model.dsl"), `# ${Date.now()}\n`);
    const started = performance.now();
    const workspace = await loadWorkspace(config);
    console.log(`One Structurizr conversion with ${runner}: ${Math.round(performance.now() - started)} ms`);
    expect(workspace).toMatchObject({ name: "Basket", model: { people: [{ name: "Shopper" }] } });
  });

  it("reports the file and line of a DSL error", { timeout: 600_000 }, async () => {
    const config = fixture("broken");
    await expect(loadWorkspace(config)).rejects.toMatchObject({
      file: "architecture/workspace.dsl",
      line: 4,
      message: expect.stringContaining('The destination element "missing" does not exist'),
    });
  });
});
