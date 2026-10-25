import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { createProgram } from "../src/program.js";
import { designSkill, installSkill, skillPath } from "../src/skill.js";

function repo(model = "architecture/workspace.dsl") {
  const root = mkdtempSync(join(tmpdir(), "bearing-skill-"));
  mkdirSync(join(root, ".bearing"));
  const text = `version: 1\nmodel: ${model}\nlanguage: typescript\n`;
  writeFileSync(join(root, ".bearing", "config.yaml"), text);
  return { root, config: parseConfig(text, root) };
}

describe("designSkill", () => {
  it("fills in the model and ADR paths from the config", () => {
    const skill = designSkill(repo("design/model.dsl").config);
    expect(skill).toMatch(/^---\nname: bearing-design\n/);
    expect(skill).toContain("changes only design/model.dsl and design/adrs/");
    expect(skill).not.toMatch(/\{\{\w+\}\}/);
  });
});

describe("installSkill", () => {
  it("writes the skill only when asked, and leaves an edited copy alone unless forced", () => {
    const { root, config } = repo();
    const file = join(root, skillPath);
    expect(existsSync(file)).toBe(false);
    expect(installSkill(config)).toBe("installed");
    expect(readFileSync(file, "utf8")).toBe(designSkill(config));
    expect(installSkill(config)).toBe("unchanged");

    writeFileSync(file, "our own steps\n");
    expect(installSkill(config)).toBe("edited");
    expect(readFileSync(file, "utf8")).toBe("our own steps\n");
    expect(installSkill(config, true)).toBe("installed");
    expect(readFileSync(file, "utf8")).toBe(designSkill(config));
  });
});

describe("bearing skill", () => {
  afterEach(() => vi.restoreAllMocks());

  async function run(root: string, ...args: string[]) {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((text) => ((stdout += String(text)), true));
    const program = createProgram();
    for (const command of [program, ...program.commands]) {
      command.exitOverride().configureOutput({ writeErr: (text) => (stderr += text) });
    }
    let exitCode = 0;
    try {
      await program.parseAsync(["skill", ...args], { from: "user" });
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      exitCode = error.exitCode;
    }
    return { stdout, stderr, exitCode };
  }

  it("prints the skill without writing anything", async () => {
    const { root, config } = repo();
    expect(await run(root)).toEqual({ stdout: designSkill(config), stderr: "", exitCode: 0 });
    expect(existsSync(join(root, ".agents"))).toBe(false);
  });

  it("installs it with --install, and refuses to replace an edited copy without --force", async () => {
    const { root } = repo();
    expect((await run(root, "--install")).stdout).toBe(`Installed ${skillPath}\n`);
    expect((await run(root, "--install")).stdout).toBe(`${skillPath} is already up to date\n`);
    writeFileSync(join(root, skillPath), "our own steps\n");
    const refused = await run(root, "--install");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("pass --force to replace it");
    expect((await run(root, "--install", "--force")).stdout).toBe(`Installed ${skillPath}\n`);
  });
});
