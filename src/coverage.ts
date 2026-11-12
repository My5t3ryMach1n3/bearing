import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { tagWhere } from "./lang/index.js";
import type { Requirement } from "./requirements.js";
import { runFile, tracesDir } from "./test.js";
import { criterionTag, testsFile, type TestRecord } from "./trace/runtime.js";

// Criteria coverage: each criterion of the issues a PR touches needs a test tagged with it that ran and passed, and no
// other test may fail. `bearing test` records every test's outcome in `.bearing/traces/`, and only tests whose names
// carry a criterion's tag count towards a criterion. See the Criteria coverage section of docs/product-spec.md.

export interface CriterionCoverage {
  // "#2/AC1"
  id: string;
  // The tag tests carry for it, from `tests.tag`.
  tag: string;
  // Where tests carry it, from the languages' adapters, e.g. "in its name".
  where: string;
  text: string;
  // Covered: a tagged test passed and none failed. Failing: a tagged test failed. Missing: no tagged test ran.
  status: "covered" | "missing" | "failing";
  tests: Array<Pick<TestRecord, "name" | "file" | "status">>;
}

export class CoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageError";
  }
}

// Reads the test outcomes `bearing test` recorded in a traces directory.
export function readTestRecords(dir: string): TestRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => testsFile.test(name))
    .sort()
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as TestRecord),
    );
}

// The test command's exit code from the last `bearing test`, or undefined if it never ran.
export function readExitCode(dir: string): number | undefined {
  const file = join(dir, runFile);
  if (!existsSync(file)) return undefined;
  const { exitCode } = JSON.parse(readFileSync(file, "utf8")) as { exitCode?: unknown };
  return typeof exitCode === "number" ? exitCode : undefined;
}

export type FailedTest = Pick<TestRecord, "name" | "file">;

// Every failed test the criteria don't already list: untagged ones, unit tests, and those of other issues. A failing
// test fails the check whatever it's tagged with, so a change can't break an earlier requirement unseen.
export function otherFailures(tests: TestRecord[], criteria: CriterionCoverage[]): FailedTest[] {
  const listed = new Set(criteria.flatMap((criterion) => criterion.tests.map((test) => `${test.file}\0${test.name}`)));
  return tests
    .filter((test) => test.status === "failed" && !listed.has(`${test.file}\0${test.name}`))
    .map(({ name, file }) => (file === undefined ? { name } : { name, file }));
}

// A test command that exited non-zero with no failed test recorded, such as one whose test file doesn't compile. Only
// once it recorded some result, so a command with no tests to run yet, as on a design PR, doesn't fail.
export function failedRun(exitCode: number | undefined, tests: TestRecord[]): number | undefined {
  if (exitCode === undefined || exitCode === 0 || tests.length === 0) return undefined;
  return tests.some((test) => test.status === "failed") ? undefined : exitCode;
}

// The coverage of every criterion of the given issues, in issue then criterion order.
export function criteriaCoverage(
  config: Config,
  requirements: Requirement[],
  issues: number[],
  tests: TestRecord[],
): CriterionCoverage[] {
  const byNumber = new Map(requirements.map((requirement) => [requirement.number, requirement]));
  const unknown = issues.filter((issue) => !byNumber.has(issue));
  if (unknown.length > 0) {
    const ids = unknown.map((issue) => `#${issue}`).join(", ");
    throw new CoverageError(`${ids} ${unknown.length === 1 ? "is not a requirement" : "are not requirements"}`);
  }
  const where = tagWhere(config);
  return [...new Set(issues)]
    .sort((a, b) => a - b)
    .flatMap((issue) => byNumber.get(issue)!.criteria.map((criterion) => ({ issue, criterion })))
    .map(({ issue, criterion }) => {
      const tag = criterionTag(config.tests.tag, issue, criterion.number);
      const tagged = tests
        .filter((test) => test.criterion === tag)
        .map(({ name, file, status }) => (file === undefined ? { name, status } : { name, file, status }));
      const status = tagged.some((test) => test.status === "failed")
        ? "failing"
        : tagged.some((test) => test.status === "passed")
          ? "covered"
          : "missing";
      return { id: criterion.id, tag, where, text: criterion.text, status, tests: tagged };
    });
}

// `recorded` is how many test results the last `bearing test` recorded, so none at all can say to run it. `failed`
// lists the other tests that failed, and `exitCode` the test command's when it failed with none to show.
export function formatCoverage(
  coverage: CriterionCoverage[],
  recorded: number,
  failed: FailedTest[] = [],
  exitCode?: number,
): string {
  const covered = coverage.filter((criterion) => criterion.status === "covered").length;
  const lines = [
    // With no issues to check, it's run only for the failures.
    coverage.length === 0 && (failed.length > 0 || exitCode !== undefined)
      ? "Criteria coverage: failed, tests failed"
      : `Criteria coverage: ${covered} of ${coverage.length} ${coverage.length === 1 ? "criterion" : "criteria"} covered`,
  ];
  const width = Math.max(0, ...coverage.map((criterion) => criterion.id.length));
  for (const criterion of coverage) {
    lines.push(`  ${criterion.id.padEnd(width)}  ${criterion.status.padEnd(7)}  ${criterion.text}`);
    if (criterion.status === "missing") {
      const skipped = criterion.tests.length;
      lines.push(
        skipped === 0
          ? `    no test tagged ${criterion.tag} ran; add an integration test with ${criterion.tag} ${criterion.where}`
          : `    ${skipped === 1 ? "its one tagged test was" : `all ${skipped} tagged tests were`} skipped`,
      );
    }
    for (const test of criterion.tests.filter((each) => each.status === "failed")) {
      lines.push(`    failed: ${test.name}${test.file === undefined ? "" : ` (${test.file})`}`);
    }
  }
  if (failed.length > 0) {
    lines.push(`  ${failed.length === 1 ? "Another test" : `${failed.length} other tests`} failed:`);
    for (const test of failed)
      lines.push(`    failed: ${test.name}${test.file === undefined ? "" : ` (${test.file})`}`);
  }
  if (exitCode !== undefined) {
    lines.push(`  The test command exited with code ${exitCode}, with no failed test to show for it; see its output.`);
  }
  if (recorded === 0) {
    lines.push("", `No test results in ${tracesDir}/; run the tests with \`bearing test\` first.`);
  }
  return `${lines.join("\n")}\n`;
}
