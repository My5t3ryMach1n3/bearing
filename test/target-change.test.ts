import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSequence } from "../src/mermaid.js";
import { modelFromWorkspace, type Model } from "../src/model.js";
import { diagramLimit, formatTargetChange } from "../src/target-change.js";

const load = (name: string) =>
  modelFromWorkspace(
    JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "target-changes", `${name}.json`), "utf8")),
  );
const section = (before: string, after: string) =>
  formatTargetChange(load(before), load(after), ["architecture/workspace.dsl"], []);

const flowcharts = (text: string) =>
  [...text.matchAll(/```mermaid\n(flowchart[\s\S]*?)\n```/g)].map((match) => match[1]!);
const headings = (text: string) => [...text.matchAll(/^#### (.+)$/gm)].map((match) => match[1]);
const elements = (chart: string) => [...chart.matchAll(/^\s+n\d+\["/gm)].length;
// The diagram under a heading.
const diagram = (text: string, heading: string) => flowcharts(text.slice(text.indexOf(`#### ${heading}`)))[0]!;

describe("a first design", () => {
  const text = section("empty", "initial");

  it("counts what it defines, rather than listing everything as added", () => {
    expect(text).toContain(
      "This is the initial target. It defines 1 person, 3 software systems, 3 containers, 5 components and 6 dynamic views.",
    );
  });

  it("draws the model's own views, plain, one per level", () => {
    expect(headings(text)).toEqual([
      "System context",
      "Containers",
      "Components of Basket API",
      "Deployment: Production",
      "Dynamic views",
    ]);
    expect(text).not.toContain("classDef");
    expect(text).not.toContain("linkStyle");
  });

  it("folds its dynamic views and the model diff", () => {
    expect(text.match(/```mermaid\nsequenceDiagram/g)).toHaveLength(6);
    expect(text).not.toContain("<details open>");
    expect(text).toContain("<details><summary>Model diff</summary>");
  });
});

describe("the sharing change, basket#16", () => {
  const text = section("initial", "sharing");

  it("says what it does in plain words", () => {
    expect(text).toContain(
      "- Adds the Basket sharing and Email outbox components to Basket API, and the external Email provider.\n",
    );
    expect(text).toContain('Basket sharing → Email outbox ("Queues the email in")');
    expect(text).toContain("- New dynamic view: #5.\n");
  });

  it("has one diagram per level, in reading order, before the model diff", () => {
    expect(headings(text)).toEqual([
      "System context: what changes",
      "Containers: what changes",
      "Components: what changes in Basket API",
      "Dynamic views",
      "Model diff",
    ]);
  });

  it("draws only what changed at a level and its direct neighbours", () => {
    const chart = diagram(text, "Components: what changes in Basket API");
    for (const name of ["Basket sharing", "Email outbox", "Basket controller", "Basket service", "Database"]) {
      expect(chart).toContain(`"${name}<br/>`);
    }
    expect(elements(chart)).toBe(6);
    expect(chart).not.toContain("Session restore");
    expect(chart).not.toContain("Auth middleware");
  });

  it("lifts a component's new relationship to the levels above it", () => {
    const chart = diagram(text, "System context: what changes");
    expect(elements(chart)).toBe(2);
    expect(chart).toMatch(/n\d+ -->\|"Sends queued email with, on a schedule"\| n\d+/);
    expect(chart).toContain("linkStyle 0 stroke:#1a7f37");
  });

  it("doesn't count relationships that only serve the new issue, in the table or the diagrams", () => {
    expect(text).toContain("19 elements and relationships now also serve #5.");
    expect(text).toContain("| Elements | `basketSharing`, `emailOutbox`, `emailProvider` |  |  |");
    expect(text).not.toContain("(requirements)");
  });
});

describe("the guest change, basket#21", () => {
  const text = section("before-guest", "guest");

  it("has a diagram only for the level that changed", () => {
    expect(headings(text)).toEqual(["Components: what changes in Basket API", "Dynamic views", "Model diff"]);
  });

  it("marks a changed description in amber, not as added", () => {
    const chart = diagram(text, "Components: what changes in Basket API");
    expect(chart).toContain("classDef changed fill:#fff8c5");
    expect(chart).not.toContain("classDef added");
    expect(text).toContain("- Changes Session restore (description).\n");
  });

  it("keeps real drift in the table and collapses the rest", () => {
    expect(text).toContain("| Elements |  |  | `sessionRestore` (description) |");
    expect(text).toContain("21 elements and relationships now also serve #20.");
  });
});

describe("every diagram of the walkthrough", () => {
  it.each([
    ["empty", "initial"],
    ["initial", "sharing"],
    ["before-guest", "guest"],
  ])(`keeps to ${diagramLimit} elements from %s to %s`, (before, after) => {
    const charts = flowcharts(section(before, after));
    expect(charts.length).toBeGreaterThan(0);
    for (const chart of charts) expect(elements(chart)).toBeLessThanOrEqual(diagramLimit);
  });
});

describe("a changed dynamic view", () => {
  it("draws before and after", () => {
    const before = load("initial");
    const after = load("initial");
    const view = after.dynamicViews.get("req-2")!;
    view.steps = view.steps.slice(0, 2);
    const text = formatTargetChange(before, after, ["architecture/workspace.dsl"], []);
    expect(text).toContain("- Changed dynamic view: #2.\n");
    expect(text).toContain("#2 Add an item to the basket (changed)");
    expect(text.indexOf("Before:")).toBeLessThan(text.indexOf("After:"));
    expect(text.match(/sequenceDiagram/g)).toHaveLength(2);
  });

  it("leaves a refreshed criteria pin in the table, since it draws the same", () => {
    const before = load("initial");
    const after = load("initial");
    after.dynamicViews.get("req-2")!.criteria = "AC1:00000000";
    const text = formatTargetChange(before, after, ["architecture/workspace.dsl"], []);
    expect(text).toContain("`req-2` (criteria)");
    expect(text).not.toContain("sequenceDiagram");
  });
});

describe("a diagram with more neighbours than the limit", () => {
  it("keeps what changed, drops neighbours and says how many", () => {
    const before = load("initial");
    const after: Model = load("initial");
    const service = after.elements.get("basketService")!;
    for (const model of [before, after]) {
      for (let index = 0; index < 20; index++) {
        const id = `helper${index}`;
        model.elements.set(id, { ...service, id, name: `Helper ${index}` });
        const relationship = [...model.relationships.values()][0]!;
        model.relationships.set(`basketService->${id}`, {
          ...relationship,
          id: `basketService->${id}`,
          source: "basketService",
          destination: id,
        });
      }
    }
    after.elements.get("basketService")!.description = "Changed";
    const text = formatTargetChange(before, after, ["architecture/workspace.dsl"], []);
    const chart = diagram(text, "Components: what changes in Basket API");
    expect(elements(chart)).toBe(diagramLimit);
    expect(chart).toContain('"Basket service<br/>');
    expect(text).toMatch(/\d+ neighbours left out to keep this readable/);
  });
});

describe("a PR that changes the workflows but not the model", () => {
  it("says the model is unchanged", () => {
    const model = load("initial");
    const text = formatTargetChange(model, model, [".github/workflows/bearing.yml"], []);
    expect(text).toContain("The model itself is unchanged.");
    expect(text).not.toContain("####");
  });
});

describe("formatSequence", () => {
  it("escapes what would end a line or read as syntax", () => {
    const steps = [{ order: "1", source: "a", destination: "b", description: 'Calls "x"; then #2\nand <more>' }];
    expect(formatSequence(steps, (id) => (id === "a" ? "end" : "B; C"))).toBe(
      "sequenceDiagram\n" +
        "  autonumber\n" +
        "  participant p0 as end\n" +
        "  participant p1 as B#59; C\n" +
        "  p0->>p1: Calls #34;x#34;#59; then #35;2 and #60;more#62;",
    );
  });
});
