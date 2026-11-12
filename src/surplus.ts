import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { ImportGraph } from "./derive.js";
import { adapters, languageOf } from "./lang/index.js";
import type { Model } from "./model.js";
import { isLive, type Requirement } from "./requirements.js";
import type { SpanRecord } from "./test.js";

// Surplus: code outside every component's path, code in components that serve only retired requirements, and exported
// functions no criterion's trace reaches. Advisory only, since a helper nothing traces may
// still be needed. See the Checks section of docs/product-spec.md.
//
// It reports files and exported functions, not lines. A function counts as reached when a test tagged with any
// criterion, of any issue, called it, so the whole repo is checked rather than the branch's change: code an earlier
// requirement stopped needing shows up too. Only the functions a language's trace hook wraps can be seen called, so
// they are all it can judge: exported functions, for TypeScript.

export interface SurplusResult {
  // Source files under no component path.
  outside: string[];
  // Components that serve only retired requirements, closed as not planned or as a duplicate, with their files: the target
  // is to prune them, and their code goes with them.
  closed: ClosedComponent[];
  // Files in components whose exported functions no tagged test called, with those functions.
  untraced: UntracedFile[];
  // Whether any tagged test's trace was recorded. Without one, nothing is reached, so untraced functions aren't
  // looked for.
  traced: boolean;
}

export interface ClosedComponent {
  component: string;
  // The closed issues it lists, e.g. ["#5"].
  issues: string[];
  files: string[];
}

export interface UntracedFile {
  file: string;
  component: string;
  // Their exported names; "default" for a default export.
  functions: string[];
}

// `closed` maps each component that serves only retired requirements to those requirements.
export function checkSurplus(
  config: Pick<Config, "root" | "languages">,
  graph: ImportGraph,
  spans: SpanRecord[],
  closed: Map<string, string[]> = new Map(),
): SurplusResult {
  const reached = new Set<string>();
  for (const span of spans) {
    if (span.criterion !== undefined) reached.add(`${span.file}#${span.name}`);
  }
  const closedComponents = graph.components
    .filter((component) => closed.has(component.id))
    .map((component) => ({ component: component.id, issues: closed.get(component.id)!, files: component.files }));
  const untraced: UntracedFile[] = [];
  if (reached.size > 0) {
    for (const component of graph.components) {
      if (closed.has(component.id)) continue;
      for (const file of component.files) {
        const language = languageOf(config, file);
        if (language === undefined) continue;
        const code = readFileSync(join(config.root, file), "utf8");
        const functions = adapters[language.name].traceHook
          .tracedFunctions(code, file)
          .filter((name) => !reached.has(`${file}#${name}`));
        if (functions.length > 0) untraced.push({ file, component: component.id, functions });
      }
    }
  }
  return { outside: graph.unmapped, closed: closedComponents, untraced, traced: reached.size > 0 };
}

// The target's components that list retired requirements, closed as not planned or as a duplicate, and no live one,
// each with the retired ones it lists. One closed as completed is live: the code still serves it.
export function closedComponents(target: Model, requirements: Requirement[]): Map<string, string[]> {
  const live = new Map(requirements.map((requirement) => [requirement.id, isLive(requirement)]));
  const closed = new Map<string, string[]>();
  for (const element of target.elements.values()) {
    if (element.type !== "component") continue;
    const issues = element.requirements.filter((id) => live.get(id) === false);
    if (issues.length > 0 && !element.requirements.some((id) => live.get(id) === true)) {
      closed.set(element.id, issues);
    }
  }
  return closed;
}

export function formatSurplus(result: SurplusResult): string {
  const flagged = result.outside.length + result.closed.length + result.untraced.length;
  const lines = [
    flagged > 0
      ? "Surplus: flagged (advisory, doesn't block merge), code that may not be needed"
      : result.traced
        ? "Surplus: passed, every source file is in a component and every exported function is reached by a tagged test"
        : "Surplus: passed, every source file is in a component",
  ];
  if (result.outside.length > 0) {
    lines.push("  Outside every component's path:", ...result.outside.map((file) => `    ${file}`));
  }
  if (result.closed.length > 0) {
    lines.push("  In components that serve only requirements closed as not planned or duplicate, to prune with them:");
    for (const { component, issues, files } of result.closed) {
      lines.push(`    ${component} (${issues.join(", ")}): ${files.length === 0 ? "no files" : files.join(", ")}`);
    }
  }
  if (result.untraced.length > 0) {
    lines.push("  Exported but never called by a test tagged with a criterion:");
    for (const { file, component, functions } of result.untraced) {
      lines.push(`    ${file} (${component}): ${functions.map((name) => `${name}()`).join(", ")}`);
    }
  }
  if (!result.traced) {
    lines.push("  Untraced functions not looked for: no tagged test's trace is recorded; run `bearing test`.");
  }
  if (flagged > 0) {
    lines.push(
      "  Remove the code if no requirement needs it, or tag a test that exercises it with the criterion it serves.",
    );
  }
  return `${lines.join("\n")}\n`;
}
