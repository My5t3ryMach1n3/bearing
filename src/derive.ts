import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Command } from "commander";
import ts from "typescript";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { loadModel } from "./diff.js";
import type { Model, Relationship } from "./model.js";
import { StructurizrError } from "./structurizr.js";
import { deriveTerraform, TerraformError, type TerraformGraph } from "./terraform.js";
import { normalizePath, within } from "./validate.js";

// What the TypeScript extractor finds in the code. This is the JSON `bearing derive` prints.
export interface ImportGraph {
  // Components that own at least one source file, with the files they own. Sorted by ID.
  components: Array<{ id: string; path: string; files: string[] }>;
  // One per pair of components where code in the source imports code declared in the destination. Sorted by ID.
  relationships: ImportRelationship[];
  // Source files under no component path: candidates for the surplus check.
  unmapped: string[];
}

// Everything `bearing derive` prints: the import graph, and the deployment from Terraform when `iac.terraform` is set.
export interface AsBuilt extends ImportGraph {
  deployment?: TerraformGraph;
}

export interface ImportRelationship {
  // "<source>-><destination>", the same stable ID the target gives a relationship.
  id: string;
  source: string;
  destination: string;
  // Every import that makes the relationship, in file and line order.
  imports: ImportSite[];
}

export interface ImportSite {
  // Repo-relative, with forward slashes.
  file: string;
  line: number;
  // The module specifier as written, e.g. "../basket-repository/index.js".
  module: string;
}

export class DeriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeriveError";
  }
}

// Tests exercise components rather than belong to them, so they make no relationships and are never surplus.
const testFile = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

// Maps every source file in the configured tsconfig to the component whose `bearing.path` holds it, then turns each
// import between two components into a relationship.
//
// An import counts towards the component that declares what it imports, not the module it names: imports are
// followed through `tsconfig` paths, barrels and re-exports, so importing the repository's `saveBasket` through
// the service's index is still a dependency on the repository. `import * as` and `export * from` depend on
// everything the module exports. Side-effect imports, `import()`, `require()` and `import("x").T` depend on the
// module's own file. Packages and anything outside the repo are ignored.
export function deriveImports(config: Config, target: Model): ImportGraph {
  const root = resolve(config.root);
  const components = [...target.elements.values()]
    .filter((element) => element.type === "component" && element.path !== undefined)
    .map((component) => ({ id: component.id, path: normalizePath(component.path!) }))
    .filter((component) => component.path !== "")
    // Longest path first, so the most specific folder wins if `bearing validate` hasn't caught an overlap yet.
    .sort((a, b) => b.path.length - a.path.length);
  const repoPath = (file: string) => relative(root, file).split(sep).join("/");
  const componentOf = (file: string) => components.find((component) => within(file, component.path))?.id;

  const program = createProgram(root, config.tsconfig);
  const checker = program.getTypeChecker();
  const sources = program
    .getRootFileNames()
    .map((name) => program.getSourceFile(name))
    .filter((file): file is ts.SourceFile => file !== undefined);

  const files = new Map<string, string>();
  const unmapped: string[] = [];
  const relationships = new Map<string, ImportRelationship>();
  for (const source of sources) {
    const file = repoPath(source.fileName);
    const owner = componentOf(file);
    if (owner === undefined) {
      unmapped.push(file);
      continue;
    }
    files.set(file, owner);
    for (const { specifier, line, declaredIn } of importsOf(source, program, checker)) {
      for (const declaration of declaredIn) {
        const path = repoPath(declaration);
        if (path.startsWith("../") || path.includes("/node_modules/") || path.startsWith("node_modules/")) continue;
        const destination = componentOf(path);
        if (destination === undefined || destination === owner) continue;
        const id = `${owner}->${destination}`;
        let relationship = relationships.get(id);
        if (relationship === undefined) {
          relationship = { id, source: owner, destination, imports: [] };
          relationships.set(id, relationship);
        }
        const site = { file, line, module: specifier.text };
        const seen = relationship.imports.some((other) => other.file === file && other.line === line);
        if (!seen) relationship.imports.push(site);
      }
    }
  }

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const owned = components
    .map(({ id, path }) => ({
      id,
      path,
      files: [...files].filter(([, owner]) => owner === id).map(([file]) => file),
    }))
    .filter((component) => component.files.length > 0);
  for (const component of owned) component.files.sort();
  for (const relationship of relationships.values()) {
    relationship.imports.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  }
  return {
    components: owned.sort(byId),
    relationships: [...relationships.values()].sort(byId),
    unmapped: unmapped.sort(),
  };
}

// The as-built model the imports give: the target's components that own code, and the relationships between them.
export function importModel(target: Model, graph: ImportGraph): Model {
  const model: Model = {
    elements: new Map(),
    relationships: new Map(),
    dynamicViews: new Map(),
    deployment: new Map(),
  };
  for (const { id } of graph.components) model.elements.set(id, target.elements.get(id)!);
  for (const { id, source, destination } of graph.relationships) {
    const relationship: Relationship = {
      id,
      source,
      destination,
      description: "",
      technology: "",
      tags: [],
      requirements: [],
      properties: {},
    };
    model.relationships.set(id, relationship);
  }
  return model;
}

// A program over the tsconfig's own files, less tests and declaration files. What they import is pulled in as
// needed, so the checker can follow it.
function createProgram(root: string, tsconfig: string): ts.Program {
  const path = join(root, tsconfig);
  if (!existsSync(path)) throw new DeriveError(`${tsconfig} not found; check "tsconfig" in .bearing/config.yaml`);
  const format = (diagnostic: ts.Diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const read = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) throw new DeriveError(`${tsconfig}: ${format(read.error)}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, resolve(path, ".."), undefined, path);
  // "No inputs were found" is left for the empty graph to show.
  const errors = parsed.errors.filter((error) => error.code !== 18003);
  if (errors.length > 0) throw new DeriveError(`${tsconfig}: ${errors.map(format).join("; ")}`);
  const rootNames = parsed.fileNames.filter((file) => {
    const repoFile = relative(root, file).split(sep).join("/");
    return !repoFile.startsWith("../") && !testFile.test(repoFile) && !/\.d\.[cm]?ts$/.test(file);
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

export function deriveCommand(): Command {
  return new Command("derive")
    .description(
      "print, as JSON, the as-built model derived from the code: which component owns each file, the relationships its imports make, the files no component owns, and the deployment nodes in the Terraform",
    )
    .action(async function (this: Command) {
      try {
        const config = loadConfig();
        const target = await loadModel(join(config.root, config.model), () => config);
        const asBuilt: AsBuilt = deriveImports(config, target);
        if (config.iac.terraform !== undefined) asBuilt.deployment = deriveTerraform(config, target);
        process.stdout.write(`${JSON.stringify(asBuilt, null, 2)}\n`);
      } catch (error) {
        if (
          error instanceof ConfigError ||
          error instanceof StructurizrError ||
          error instanceof DeriveError ||
          error instanceof TerraformError
        ) {
          this.error(`error: ${error.message}`);
        }
        throw error;
      }
    });
}
