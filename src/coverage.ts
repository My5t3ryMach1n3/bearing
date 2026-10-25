import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { loadRequirements, RequirementsError, type Requirement } from "./requirements.js";
import { tracesDir } from "./test.js";
import { criterionTag, testsFile, type TestRecord } from "./trace/runtime.js";

// Criteria coverage: each criterion of the issues a PR touches needs a test tagged with it that ran and passed.
// `bearing test` records every test's outcome in `.bearing/traces/`, and only tests whose names carry a criterion's
// tag count. See the Criteria coverage section of docs/product-spec.md.

export interface CriterionCoverage {
  // "#2/AC1"
  id: string;
  // The tag tests carry for it, from `tests.tag`.
  tag: string;
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
      return { id: criterion.id, tag, text: criterion.text, status, tests: tagged };
    });
}

export function formatCoverage(coverage: CriterionCoverage[], tests: TestRecord[]): string {
  const covered = coverage.filter((criterion) => criterion.status === "covered").length;
  const lines = [
    `Criteria coverage: ${covered} of ${coverage.length} ${coverage.length === 1 ? "criterion" : "criteria"} covered`,
  ];
  const width = Math.max(0, ...coverage.map((criterion) => criterion.id.length));
  for (const criterion of coverage) {
    lines.push(`  ${criterion.id.padEnd(width)}  ${criterion.status.padEnd(7)}  ${criterion.text}`);
    if (criterion.status === "missing") {
      const skipped = criterion.tests.length;
      lines.push(
        skipped === 0
          ? `    no test tagged ${criterion.tag} ran; add an integration test with ${criterion.tag} in its name`
          : `    ${skipped === 1 ? "its one tagged test was" : `all ${skipped} tagged tests were`} skipped`,
      );
    }
    for (const test of criterion.tests.filter((each) => each.status === "failed")) {
      lines.push(`    failed: ${test.name}${test.file === undefined ? "" : ` (${test.file})`}`);
    }
  }
  if (tests.length === 0) {
    lines.push("", `No test results in ${tracesDir}/; run the tests with \`bearing test\` first.`);
  }
  return `${lines.join("\n")}\n`;
}

export function checkCommand(): Command {
  return new Command("check")
    .description(
      "check that each criterion of the given issues has a tagged test that ran and passed under `bearing test`; exits non-zero if any is missing or failing",
    )
    .argument("<issues...>", 'the issues the change works on, e.g. 2 4 or "#2"')
    .option("--json", "print the coverage as JSON instead of text")
    .action(async function (this: Command, issues: string[], options: { json?: boolean }) {
      const numbers = issues.map((issue) => /^#?(\d+)$/.exec(issue.trim())?.[1]);
      const bad = issues.find((_, index) => numbers[index] === undefined);
      // An unquoted #2 is a shell comment, so `bearing check #2` arrives here with no issues at all.
      if (bad !== undefined) this.error(`error: "${bad}" is not an issue number, e.g. 2 or '#2'`);
      try {
        const config = loadConfig();
        const requirements = await loadRequirements(config);
        const tests = readTestRecords(join(config.root, tracesDir));
        const coverage = criteriaCoverage(config, requirements, numbers.map(Number), tests);
        process.stdout.write(
          options.json === true ? `${JSON.stringify({ coverage }, null, 2)}\n` : formatCoverage(coverage, tests),
        );
        if (coverage.some((criterion) => criterion.status !== "covered")) process.exitCode = 1;
      } catch (error) {
        if (error instanceof ConfigError || error instanceof RequirementsError || error instanceof CoverageError) {
          this.error(`error: ${error.message}`);
        }
        throw error;
      }
    });
}
