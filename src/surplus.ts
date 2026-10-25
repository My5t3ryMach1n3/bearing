import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { ImportGraph } from "./derive.js";
import type { Model } from "./model.js";
import type { Requirement } from "./requirements.js";
import type { SpanRecord } from "./test.js";

// Surplus: code outside every component's path, code in components that serve only closed requirements, and exported
// functions no criterion's trace reaches. Advisory only,
// since a helper nothing traces may still be needed. See the Checks section of docs/product-spec.md.
//
// It reports files and exported functions, not lines. A function counts as reached when a test tagged with any
// criterion, of any issue, called it, so the whole repo is checked rather than the branch's change: code an earlier
// requirement stopped needing shows up too. Only exported functions are traced, so they are all it can judge.

export interface SurplusResult {
  // Source files under no component path.
  outside: string[];
  // Components that serve only closed requirements, such as one closed as not planned, with their files: the target
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

// `closed` maps each component that serves only closed requirements to those requirements.
export function checkSurplus(
  root: string,
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
        const code = readFileSync(join(root, file), "utf8");
        const functions = exportedFunctions(code, file).filter((name) => !reached.has(`${file}#${name}`));
        if (functions.length > 0) untraced.push({ file, component: component.id, functions });
      }
    }
  }
  return { outside: graph.unmapped, closed: closedComponents, untraced, traced: reached.size > 0 };
}

// The target's components that list closed requirements and no open one, each with the closed ones it lists.
export function closedComponents(target: Model, requirements: Requirement[]): Map<string, string[]> {
  const state = new Map(requirements.map((requirement) => [requirement.id, requirement.state]));
  const closed = new Map<string, string[]>();
  for (const element of target.elements.values()) {
    if (element.type !== "component") continue;
    const issues = element.requirements.filter((id) => state.get(id) === "closed");
    if (issues.length > 0 && !element.requirements.some((id) => state.get(id) === "open")) {
      closed.set(element.id, issues);
    }
  }
  return closed;
}

// The names a module exports functions under, as the trace hook wraps them: function declarations with a body,
// variables initialised with a function or arrow function, and default exports of either. Classes, re-exports and
// other values aren't traced, so they aren't listed. Sorted.
export function exportedFunctions(code: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  // Top-level functions by local name.
  const functions = new Set<string>();
  const names = new Set<string>();
  const lists: ts.ExportSpecifier[] = [];
  const isFunction = (node: ts.Expression | undefined) =>
    node !== undefined && (ts.isFunctionExpression(node) || ts.isArrowFunction(node));

  for (const statement of source.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.body === undefined) continue;
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      if (statement.name !== undefined) functions.add(statement.name.text);
      if (exported) names.add(isDefault ? "default" : statement.name!.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !isFunction(declaration.initializer)) continue;
        functions.add(declaration.name.text);
        if (exported) names.add(declaration.name.text);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = statement.expression;
      if (isFunction(expression) || (ts.isIdentifier(expression) && functions.has(expression.text))) {
        names.add("default");
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      !statement.isTypeOnly &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      lists.push(...statement.exportClause.elements.filter((element) => !element.isTypeOnly));
    }
  }
  // `export { a as b }` may come before `a` is declared.
  for (const element of lists) {
    if (functions.has((element.propertyName ?? element.name).text)) names.add(element.name.text);
  }
  return [...names].sort();
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
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
    lines.push("  In components that serve only closed requirements, to prune with them:");
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
