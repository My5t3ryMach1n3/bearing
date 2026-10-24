import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { dockerImage, loadWorkspace, StructurizrError, type Run } from "../src/structurizr.js";

function repo(runner: "docker" | "java" = "docker"): Config {
  const root = mkdtempSync(join(tmpdir(), "bearing-structurizr-"));
  mkdirSync(join(root, "architecture"));
  writeFileSync(join(root, "architecture", "workspace.dsl"), "workspace {\n  !include model.dsl\n}\n");
  writeFileSync(join(root, "architecture", "model.dsl"), 'shopper = person "Shopper"\n');
  const text = `version: 1\nmodel: architecture/workspace.dsl\nstructurizr:\n  runner: ${runner}\nlanguage: typescript\n`;
  return parseConfig(text, root);
}

// A fake Structurizr: records each call and exports `workspace` to the -o directory.
function fakeRun(workspace: object = { name: "Basket" }) {
  const calls: Array<[string, ...string[]]> = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (!args.includes("export")) return { code: 0, output: "" };
    const out = args[args.indexOf("-o") + 1] ?? "";
    // Docker writes to the /out mount, which the fake maps back to the host directory.
    const host = out === "/out" ? (args.find((arg) => arg.endsWith(":/out")) ?? "").slice(0, -":/out".length) : out;
    writeFileSync(join(host, "workspace.json"), JSON.stringify(workspace));
    return { code: 0, output: "Finished" };
  };
  return { run, calls, exports: () => calls.filter((call) => call.includes("export")) };
}

const quiet = { log: () => {} };

describe("loadWorkspace", () => {
  it("exports the DSL with the pinned Docker image, mounting only the model directory", async () => {
    const config = repo();
    const fake = fakeRun();
    const cacheDir = mkdtempSync(join(tmpdir(), "bearing-cache-"));
    expect(await loadWorkspace(config, { cacheDir, run: fake.run, ...quiet })).toEqual({ name: "Basket" });
    const [call] = fake.exports();
    expect(call?.slice(0, 2)).toEqual(["docker", "run"]);
    expect(call).toContain(`${join(config.root, "architecture")}:/workspace:ro`);
    expect(call?.slice(call.indexOf(dockerImage))).toEqual([
      dockerImage,
      ...["export", "-w", "/workspace/workspace.dsl", "-f", "json", "-o", "/out"],
    ]);
  });

  it("reuses the cached JSON while the model is unchanged", async () => {
    const config = repo();
    const fake = fakeRun();
    const cacheDir = mkdtempSync(join(tmpdir(), "bearing-cache-"));
    await loadWorkspace(config, { cacheDir, run: fake.run, ...quiet });
    expect(await loadWorkspace(config, { cacheDir, run: fake.run, ...quiet })).toEqual({ name: "Basket" });
    expect(fake.calls).toHaveLength(2); // one image check and one export
  });

  it("re-runs Structurizr when an included file changes", async () => {
    const config = repo();
    const fake = fakeRun();
    const cacheDir = mkdtempSync(join(tmpdir(), "bearing-cache-"));
    await loadWorkspace(config, { cacheDir, run: fake.run, ...quiet });
    writeFileSync(join(config.root, "architecture", "model.dsl"), 'shopper = person "Customer"\n');
    await loadWorkspace(config, { cacheDir, run: fake.run, ...quiet });
    expect(fake.exports()).toHaveLength(2);
  });

  it("says when the Docker image needs pulling", async () => {
    const config = repo();
    const fake = fakeRun();
    const run: Run = async (command, args) => (args[0] === "image" ? { code: 1, output: "" } : fake.run(command, args));
    const logged: string[] = [];
    const cacheDir = mkdtempSync(join(tmpdir(), "bearing-cache-"));
    await loadWorkspace(config, { cacheDir, run, log: (message) => logged.push(message) });
    expect(logged).toEqual([expect.stringMatching(/^Pulling Structurizr \d{4}\.\d{2}\.\d{2}/)]);
  });

  it("runs the cached .war with Java", async () => {
    const config = repo("java");
    const fake = fakeRun();
    const cacheDir = mkdtempSync(join(tmpdir(), "bearing-cache-"));
    const warPath = join(cacheDir, "structurizr-2026.09.19.war");
    writeFileSync(warPath, "");
    await loadWorkspace(config, { cacheDir, run: fake.run, ...quiet });
    const [call] = fake.exports();
    expect(call?.slice(0, 6)).toEqual([
      ...["java", "-jar", warPath, "export", "-w"],
      join(config.root, "architecture", "workspace.dsl"),
    ]);
  });

  it("refuses a downloaded .war whose checksum doesn't match", async () => {
    const config = repo("java");
    const cacheDir = mkdtempSync(join(tmpdir(), "bearing-cache-"));
    const fetchWar = (async () => new Response("not structurizr")) as typeof fetch;
    await expect(loadWorkspace(config, { cacheDir, run: fakeRun().run, fetch: fetchWar, ...quiet })).rejects.toThrow(
      /has checksum [0-9a-f]{64}, expected [0-9a-f]{64}/,
    );
  });

  it("reports a DSL error with the repo-relative file and line", async () => {
    const config = repo();
    const output = [
      "11:41:47.990 [main] INFO com.structurizr.command.ExportCommand -- Exporting workspace from /workspace/workspace.dsl",
      'com.structurizr.dsl.StructurizrDslParserException: The destination element "missing" does not exist at line 4 of /workspace/model.dsl: shopper -> missing "Uses"',
      "\tat com.structurizr.dsl.StructurizrDslParser.parse(StructurizrDslParser.java:1369)",
    ].join("\n");
    const run: Run = async (_command, args) => ({ code: args.includes("export") ? 1 : 0, output });
    const cacheDir = mkdtempSync(join(tmpdir(), "bearing-cache-"));
    const error = await loadWorkspace(config, { cacheDir, run, ...quiet }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(StructurizrError);
    expect(error).toMatchObject({ file: "architecture/model.dsl", line: 4 });
    expect((error as Error).message).toBe('architecture/model.dsl:4: The destination element "missing" does not exist');
  });

  it("explains a missing runner", async () => {
    const config = repo();
    const run: Run = async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    };
    const cacheDir = mkdtempSync(join(tmpdir(), "bearing-cache-"));
    await expect(loadWorkspace(config, { cacheDir, run, ...quiet })).rejects.toThrow(
      /docker was not found; install Docker, or set structurizr.runner to java/,
    );
  });

  it("explains a missing model file", async () => {
    const config = { ...repo(), model: "architecture/missing.dsl" };
    await expect(loadWorkspace(config, { run: fakeRun().run, ...quiet })).rejects.toThrow(
      /^architecture\/missing\.dsl: model not found/,
    );
  });
});
