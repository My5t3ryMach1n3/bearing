import { readFileSync } from "node:fs";
import { CommanderError } from "commander";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

// Runs the CLI in-process, capturing output and turning exits into a result instead of ending the test run.
async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const program = createProgram()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => (stdout += text),
      writeErr: (text) => (stderr += text),
    });
  let exitCode = 0;
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { stdout, stderr, exitCode };
}

describe("bearing", () => {
  it.each(["--version", "-v"])("prints the package version for %s", async (flag) => {
    const result = await run(flag);
    expect(result).toEqual({ stdout: `${packageVersion}\n`, stderr: "", exitCode: 0 });
  });

  it.each([["--help"], ["-h"], []])("prints usage for %j", async (...args) => {
    const result = await run(...args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Usage: bearing \[options\]/);
    expect(result.stdout).toContain("--version");
  });

  it("rejects an unknown option with usage on stderr", async () => {
    const result = await run("--bogus");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown option '--bogus'");
    expect(result.stderr).toContain("Usage: bearing");
  });
});
