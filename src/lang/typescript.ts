import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import { join, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { componentOf, declarationFile, testFile } from "../paths.js";
import { traceEnv } from "../trace/env.js";
import { DeriveError, TraceHookError, type LanguageAdapter } from "./adapter.js";

// TypeScript and JavaScript: imports through the compiler's own checker, tracing through a Node preload, and tags in
// test names. The first adapter, and the model for the rest; see docs/language-adapters.md.

// The module every Node process the tests start preloads. See src/trace/register.ts.
const defaultHook = new URL("../trace/register.js", import.meta.url);

export const typescript: LanguageAdapter = {
  name: "typescript",
  sourceFile: /\.[cm]?[jt]sx?$/,

  // Maps every source file in the language's tsconfig to its component, then keeps each import whose code is
  // declared in another component.
  //
  // An import counts towards the component that declares what it imports, not the module it names: imports are
  // followed through `tsconfig` paths, barrels and re-exports, so importing the repository's `saveBasket` through
  // the service's index is still a dependency on the repository. `import * as` and `export * from` depend on
  // everything the module exports. Side-effect imports, `import()`, `require()` and `import("x").T` depend on the
  // module's own file. Packages and anything outside the repo are ignored.
  extractImports(repoRoot, language, components) {
    const root = resolve(repoRoot);
    const repoPath = (file: string) => relative(root, file).split(sep).join("/");
    const program = createProgram(root, posix.join(language.root, language.project));
    const checker = program.getTypeChecker();
    const sources = program
      .getRootFileNames()
      .map((name) => program.getSourceFile(name))
      .filter((file): file is ts.SourceFile => file !== undefined);

    const files: string[] = [];
    const imports: ReturnType<LanguageAdapter["extractImports"]>["imports"] = [];
    for (const source of sources) {
      const file = repoPath(source.fileName);
      files.push(file);
      const owner = componentOf(file, components);
      if (owner === undefined) continue;
      for (const { specifier, line, declaredIn } of importsOf(source, program, checker)) {
        for (const declaration of declaredIn) {
          const path = repoPath(declaration);
          if (path.startsWith("../") || path.includes("/node_modules/") || path.startsWith("node_modules/")) continue;
          const destination = componentOf(path, components);
          if (destination === undefined || destination === owner) continue;
          imports.push({ file, line, module: specifier.text, destination });
        }
      }
    }
    return { files, imports };
  },

  // Preloads src/trace/register.ts into every Node process with `--import`; it reads its settings from one
  // environment variable.
  traceHook: {
    env(env, settings, options) {
      // `registerHooks` arrived in Node 22.15; `engines` only promises 22.
      if (typeof (nodeModule as { registerHooks?: unknown }).registerHooks !== "function") {
        throw new TraceHookError(`tracing needs Node.js 22.15 or later; this is ${process.version}`);
      }
      const preload = `--import=${(options.hook ?? defaultHook).href}`;
      const nodeOptions = [env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
      return { ...env, NODE_OPTIONS: nodeOptions, [traceEnv]: JSON.stringify(settings) };
    },
    tracedFunctions: exportedFunctions,
  },

  // The runtime finds the tag in the test's full name, describe blocks included.
  tagCarrier: { where: "in its name" },
};

// A program over the tsconfig's own files, less tests and declaration files. What they import is pulled in as
// needed, so the checker can follow it.
function createProgram(root: string, tsconfig: string): ts.Program {
  const path = join(root, tsconfig);
  if (!existsSync(path)) {
    throw new DeriveError(`${tsconfig} not found; check the TypeScript project file in .bearing/config.yaml`);
  }
  const format = (diagnostic: ts.Diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const read = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) throw new DeriveError(`${tsconfig}: ${format(read.error)}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, resolve(path, ".."), undefined, path);
  // "No inputs were found" is left for the empty graph to show.
  const errors = parsed.errors.filter((error) => error.code !== 18003);
  if (errors.length > 0) throw new DeriveError(`${tsconfig}: ${errors.map(format).join("; ")}`);
  const rootNames = parsed.fileNames.filter((file) => {
    const repoFile = relative(root, file).split(sep).join("/");
    return !repoFile.startsWith("../") && !testFile.test(repoFile) && !declarationFile.test(file);
  });
  return ts.createProgram({ rootNames, options: { ...parsed.options, noEmit: true } });
}

interface Import {
  specifier: ts.StringLiteralLike;
  // Where the import statement or call starts, 1-based.
  line: number;
  // Absolute paths of the files declaring what the import uses.
  declaredIn: string[];
}

function importsOf(source: ts.SourceFile, program: ts.Program, checker: ts.TypeChecker): Import[] {
  const imports: Import[] = [];
  const moduleOf = (specifier: ts.StringLiteralLike) => checker.getSymbolAtLocation(specifier);
  // The file a module specifier resolves to, falling back to plain resolution for `require()` in TypeScript files.
  const moduleFile = (specifier: ts.StringLiteralLike): string[] => {
    const declaration = moduleOf(specifier)?.declarations?.[0];
    if (declaration !== undefined) return [declaration.getSourceFile().fileName];
    const mode = program.getModeForUsageLocation(source, specifier);
    const resolved = ts.resolveModuleName(
      specifier.text,
      source.fileName,
      program.getCompilerOptions(),
      ts.sys,
      undefined,
      undefined,
      mode,
    );
    return resolved.resolvedModule === undefined ? [] : [resolved.resolvedModule.resolvedFileName];
  };
  const everyExport = (specifier: ts.StringLiteralLike): string[] => {
    const module = moduleOf(specifier);
    const exports = module === undefined ? [] : checker.getExportsOfModule(module);
    return exports.length === 0 ? moduleFile(specifier) : exports.flatMap((symbol) => declaringFiles(symbol, checker));
  };
  const named = (name: ts.Node): string[] => {
    const symbol = checker.getSymbolAtLocation(name);
    return symbol === undefined ? [] : declaringFiles(symbol, checker);
  };
  const add = (at: ts.Node, specifier: ts.Expression | undefined, declaredIn: () => string[]) => {
    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
      const line = source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1;
      imports.push({ specifier, line, declaredIn: [...new Set(declaredIn())] });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      add(node, node.moduleSpecifier, () => {
        if (clause === undefined) return moduleFile(node.moduleSpecifier as ts.StringLiteralLike);
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          return everyExport(node.moduleSpecifier as ts.StringLiteralLike);
        }
        return [
          ...(clause.name === undefined ? [] : named(clause.name)),
          ...(bindings === undefined ? [] : bindings.elements.flatMap((element) => named(element.name))),
        ];
      });
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      add(node, node.moduleSpecifier, () =>
        clause === undefined || ts.isNamespaceExport(clause)
          ? everyExport(node.moduleSpecifier as ts.StringLiteralLike)
          : clause.elements.flatMap((element) => {
              const symbol = checker.getExportSpecifierLocalTargetSymbol(element);
              return symbol === undefined ? [] : declaringFiles(symbol, checker);
            }),
      );
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteralLike(expression)) add(node, expression, () => moduleFile(expression));
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const [argument] = node.arguments;
      if ((isImport || isRequire) && argument !== undefined && ts.isStringLiteralLike(argument)) {
        add(node, argument, () => moduleFile(argument));
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteralLike(literal)) add(node, literal, () => moduleFile(literal));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

// The files that declare what a symbol finally stands for, after following every alias and re-export.
function declaringFiles(symbol: ts.Symbol, checker: ts.TypeChecker): string[] {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return (target.declarations ?? []).map((declaration) => declaration.getSourceFile().fileName);
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
