import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { CoverageError, criteriaCoverage, formatCoverage, readTestRecords } from "../src/coverage.js";
import { loadRequirements } from "../src/requirements.js";
import type { TestRecord } from "../src/trace/runtime.js";
import { basketDir } from "./basket.js";

const issuesFile = join(basketDir, "issues.json");
const config = loadConfig(join(basketDir, "repo"));
const requirements = await loadRequirements(config, { issuesFile });

const passed = (criterion: string, name = `${criterion} works`): TestRecord => ({
  name,
  file: "test/integration/basket.test.ts",
  status: "passed",
  criterion,
});
const failed = (criterion: string): TestRecord => ({ ...passed(criterion, `${criterion} breaks`), status: "failed" });
const skipped = (criterion: string): TestRecord => ({ ...passed(criterion, `${criterion} later`), status: "skipped" });

const statuses = (tests: TestRecord[], issues = [2]) =>
  criteriaCoverage(config, requirements, issues, tests).map(({ id, status }) => `${id} ${status}`);

describe("criteriaCoverage", () => {
  it("covers a criterion with a passing tagged test", () => {
    expect(statuses([passed("#2/AC1"), passed("#2/AC2")])).toEqual(["#2/AC1 covered", "#2/AC2 covered"]);
  });

  it("lists a criterion no tagged test ran for as missing", () => {
    expect(statuses([passed("#2/AC1"), passed("#3/AC2")])).toEqual(["#2/AC1 covered", "#2/AC2 missing"]);
  });

  it("fails a criterion if any of its tagged tests failed, even when another passed", () => {
    expect(statuses([passed("#2/AC1"), failed("#2/AC1"), failed("#2/AC2")])).toEqual([
      "#2/AC1 failing",
      "#2/AC2 failing",
    ]);
  });

  it("doesn't count a skipped test as having run", () => {
    expect(statuses([skipped("#2/AC1"), passed("#2/AC2")])).toEqual(["#2/AC1 missing", "#2/AC2 covered"]);
  });

  it("never counts untagged tests, even ones that mention the criterion's issue", () => {
    const untagged: TestRecord[] = [
      { name: "#2 Add an item > keeps an added item", status: "passed" },
      { name: "add item AC1", status: "passed" },
    ];
    expect(statuses(untagged)).toEqual(["#2/AC1 missing", "#2/AC2 missing"]);
  });

  it("lists every criterion of each issue, in order, once", () => {
    expect(statuses([], [7, 2, 7])).toEqual(["#2/AC1 missing", "#2/AC2 missing", "#7/AC1 missing"]);
  });

  it("matches tests by the configured tag", () => {
    const custom = parseConfig(
      'version: 1\nmodel: a.dsl\nlanguage: typescript\ntests:\n  tag: "[REQ-<issue>.<n>]"\n',
      "/repo",
    );
    const coverage = criteriaCoverage(custom, requirements, [7], [passed("[REQ-7.1]")]);
    expect(coverage).toEqual([
      {
        id: "#7/AC1",
        tag: "[REQ-7.1]",
        text: "Given a basket with items, when the shopper empties it, then the basket is empty.",
        status: "covered",
        tests: [{ name: "[REQ-7.1] works", file: "test/integration/basket.test.ts", status: "passed" }],
      },
    ]);
  });

  it("rejects issues that aren't requirements", () => {
    expect(() => criteriaCoverage(config, requirements, [2, 5], [])).toThrow(CoverageError);
    expect(() => criteriaCoverage(config, requirements, [5], [])).toThrow("#5 is not a requirement");
    expect(() => criteriaCoverage(config, requirements, [5, 99], [])).toThrow("#5, #99 are not requirements");
  });
});

describe("formatCoverage", () => {
  it("says what to do about each criterion that isn't covered", () => {
    const tests = [passed("#2/AC1"), failed("#3/AC1"), passed("#3/AC1"), skipped("#3/AC2")];
    expect(formatCoverage(criteriaCoverage(config, requirements, [2, 3], tests), tests.length)).toBe(
      [
        "Criteria coverage: 1 of 4 criteria covered",
        "  #2/AC1  covered  Given a signed-in shopper, when they add an item, then the basket persists across sessions.",
        "  #2/AC2  missing  Given a product that isn't in the catalogue, when a shopper adds it, then the request is rejected and the basket is unchanged.",
        "    no test tagged #2/AC2 ran; add an integration test with #2/AC2 in its name",
        "  #3/AC1  failing  Given an item in the basket, when the shopper removes it, then it is no longer in the basket.",
        "    failed: #3/AC1 breaks (test/integration/basket.test.ts)",
        "  #3/AC2  missing  Given an item that isn't in the basket, when the shopper removes it, then the request is rejected as not found.",
        "    its one tagged test was skipped",
        "",
      ].join("\n"),
    );
  });

  it("points to `bearing test` when there are no results at all", () => {
    expect(formatCoverage(criteriaCoverage(config, requirements, [7], []), 0)).toContain(
      "No test results in .bearing/traces/; run the tests with `bearing test` first.",
    );
  });
});

describe("readTestRecords", () => {
  it("reads every tests file and ignores spans", () => {
    const dir = mkdtempSync(join(tmpdir(), "bearing-coverage-"));
    writeFileSync(
      join(dir, "tests-1-0.jsonl"),
      `${JSON.stringify(passed("#2/AC1"))}\n${JSON.stringify(failed("#2/AC2"))}\n`,
    );
    writeFileSync(join(dir, "tests-2-1.jsonl"), `${JSON.stringify(skipped("#7/AC1"))}\n`);
    writeFileSync(join(dir, "spans-1-0.jsonl"), '{"resourceSpans":[]}\n');
    expect(readTestRecords(dir)).toEqual([passed("#2/AC1"), failed("#2/AC2"), skipped("#7/AC1")]);
  });

  it("reads nothing from a directory that isn't there", () => {
    expect(readTestRecords(join(tmpdir(), "bearing-no-such-dir"))).toEqual([]);
  });
});
