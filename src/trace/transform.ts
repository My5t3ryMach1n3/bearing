import { createRequire } from "node:module";
import type ts from "typescript";

// TypeScript is loaded on first use: the hook loads this module into every test process, most of which never load
// a component's code.
const require = createRequire(import.meta.url);
let loaded: typeof ts | undefined;
const typescript = (): typeof ts => (loaded ??= require("typescript") as typeof ts);

// Where the instrumented code finds the trace runtime: a global the hook installs in every test process, so the
// rewritten modules import nothing and run unchanged when tracing is off.
export const runtimeKey = "bearing.trace";

// The component and repo-relative file a traced module belongs to.
export interface TracedFile {
  component: string;
  file: string;
}

const runtime = (traced: TracedFile) =>
  `globalThis[Symbol.for(${JSON.stringify(runtimeKey)})]?.module(${JSON.stringify(traced.component)}, ${JSON.stringify(traced.file)})`;

const defaultName = "__bearing_default";
const traceName = "__bearing_trace";

interface Edit {
  start: number;
  end: number;
  text: string;
}

// Rewrites an ES module, in TypeScript or JavaScript, so every function it exports is wrapped in a span.
//
// Each exported binding the module declares is reassigned to its wrapped value at the end of the module, so other
// modules, which read exports as live bindings, call the wrapper. `const` becomes `let` to allow that, and
// `export default <expression>` is bound to a name first. Re-exports are left alone: the module that declares a
// function wraps it. Every edit stays on the line it replaces, so stack traces and source maps still line up.
export function instrumentModule(code: string, fileName: string, traced: TracedFile): string {
  const ts = typescript();
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const edits: Edit[] = [];
  // Top-level bindings that can be reassigned, by name, with the `const` keyword to loosen if there is one.
  const locals = new Map<string, ts.VariableDeclarationList | undefined>();
  // Local name to the name it's exported as.
  const wrapped = new Map<string, string>();
  const exportLists: ts.ExportSpecifier[] = [];
  let defaultExpression = false;

  for (const statement of source.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
    if (ts.isFunctionDeclaration(statement)) {
      // Overload signatures have no body and emit nothing.
      if (statement.body === undefined) continue;
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      if (statement.name !== undefined) {
        locals.set(statement.name.text, undefined);
        if (exported) wrapped.set(statement.name.text, isDefault ? "default" : statement.name.text);
      } else if (exported && isDefault) {
        // `export default function () {}` exports the function's own binding once it has a name.
        const keyword = statement.asteriskToken ?? findToken(statement, ts.SyntaxKind.FunctionKeyword, source);
        if (keyword !== undefined) {
          edits.push({ start: keyword.end, end: keyword.end, text: ` ${defaultName}` });
          wrapped.set(defaultName, "default");
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        locals.set(declaration.name.text, statement.declarationList);
        if (exported) wrapped.set(declaration.name.text, declaration.name.text);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      edits.push({
        start: statement.getStart(source),
        end: statement.expression.getStart(source),
        text: `const ${defaultName} = `,
      });
      defaultExpression = true;
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      !statement.isTypeOnly &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      exportLists.push(...statement.exportClause.elements.filter((element) => !element.isTypeOnly));
    }
  }
  // `export { a as b }` may come before `a` is declared, and names imports too, which aren't this module's to wrap.
  for (const element of exportLists) {
    const local = (element.propertyName ?? element.name).text;
    if (locals.has(local) && !wrapped.has(local)) wrapped.set(local, element.name.text);
  }
  const loosened = new Set<ts.VariableDeclarationList>();
  for (const local of wrapped.keys()) {
    const list = locals.get(local);
    if (list === undefined || loosened.has(list) || !(list.flags & ts.NodeFlags.Const)) continue;
    const start = list.getStart(source);
    if (code.slice(start, start + 5) === "const") edits.push({ start, end: start + 5, text: "let  " });
    loosened.add(list);
  }
  if (wrapped.size === 0 && !defaultExpression) return code;

  const appended = [`const ${traceName} = ${runtime(traced)};`];
  if (wrapped.size > 0) {
    const assignments = [...wrapped].map(
      ([local, name]) => `${local} = ${traceName}.wrap(${local}, ${JSON.stringify(name)});`,
    );
    appended.push(`if (${traceName}) { ${assignments.join(" ")} }`);
  }
  if (defaultExpression) {
    appended.push(`export default ${traceName} ? ${traceName}.wrap(${defaultName}, "default") : ${defaultName};`);
  }
  return applyEdits(code, edits) + `\n;${appended.join(" ")}\n`;
}

// Wraps the functions a CommonJS module leaves on `module.exports` once it has run.
export function instrumentCommonJs(code: string, traced: TracedFile): string {
  return `${code}\n;${runtime(traced)}?.wrapExports(module);\n`;
}

function scriptKind(fileName: string): ts.ScriptKind {
  const ts = typescript();
  if (/\.[cm]?tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.[cm]?jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const ts = typescript();
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function findToken(node: ts.Node, kind: ts.SyntaxKind, source: ts.SourceFile): ts.Node | undefined {
  return node.getChildren(source).find((child) => child.kind === kind);
}

function applyEdits(code: string, edits: Edit[]): string {
  let result = "";
  let at = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    result += code.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return result + code.slice(at);
}
