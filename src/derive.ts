import { join } from "node:path";
import { Command } from "commander";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { loadModel } from "./diff.js";
import { DeriveError } from "./lang/adapter.js";
import { adapters, languageOf } from "./lang/index.js";
import type { Model, Relationship } from "./model.js";
import { componentOf, componentPaths } from "./paths.js";
import { StructurizrError } from "./structurizr.js";
import { deriveQueues, type QueueRelationship } from "./queues.js";
import { IacError, type DeploymentGraph } from "./deployment.js";
import { deriveDeployment } from "./iac.js";
import { readTerraform } from "./terraform.js";

// What the language adapters find in the code. This is the JSON `bearing derive` prints.
export interface ImportGraph {
  // Components that own at least one source file, with the files they own. Sorted by ID.
  components: Array<{ id: string; path: string; files: string[] }>;
  // One per pair of components where code in the source imports code declared in the destination. Sorted by ID.
  relationships: ImportRelationship[];
  // Source files under no component path: candidates for the surplus check.
  unmapped: string[];
}

// Everything `bearing derive` prints: the import graph, the deployment when `iac.terraform` or `iac.kubernetes` is
// set, and the relationships through queues when `iac.terraform` is.
export interface AsBuilt extends ImportGraph {
  deployment?: DeploymentGraph;
  queues?: QueueRelationship[];
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

export { DeriveError } from "./lang/adapter.js";

// Reads the code of every configured language with its adapter, maps each source file to the component whose
// `bearing.path` holds it, and turns each import between two components into a relationship. A file two languages
// read, such as one under nested roots, counts once, for the language `languageOf` gives it.
export function deriveImports(config: Config, target: Model): ImportGraph {
  const components = componentPaths(target);
  const files = new Map<string, string>();
  const unmapped = new Set<string>();
  const relationships = new Map<string, ImportRelationship>();
  for (const language of config.languages) {
    const extracted = adapters[language.name].extractImports(config.root, language, components);
    const ours = (file: string) => languageOf(config, file) === language;
    for (const file of extracted.files.filter(ours)) {
      const owner = componentOf(file, components);
      if (owner === undefined) unmapped.add(file);
      else files.set(file, owner);
    }
    for (const { file, line, module, destination } of extracted.imports) {
      const owner = files.get(file);
      if (!ours(file) || owner === undefined || owner === destination) continue;
      const id = `${owner}->${destination}`;
      let relationship = relationships.get(id);
      if (relationship === undefined) {
        relationship = { id, source: owner, destination, imports: [] };
        relationships.set(id, relationship);
      }
      const seen = relationship.imports.some((other) => other.file === file && other.line === line);
      if (!seen) relationship.imports.push({ file, line, module });
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
    unmapped: [...unmapped].sort(),
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

export function deriveCommand(): Command {
  return new Command("derive")
    .description(
      "print, as JSON, the as-built model derived from the code: which component owns each file, the relationships its imports make, the files no component owns, the deployment nodes in the Terraform or Kubernetes manifests, and the relationships through queues in the Terraform",
    )
    .action(async function (this: Command) {
      try {
        const config = loadConfig();
        const target = await loadModel(join(config.root, config.model), () => config);
        const asBuilt: AsBuilt = deriveImports(config, target);
        const blocks = config.iac.terraform === undefined ? undefined : readTerraform(config);
        const deployment = deriveDeployment(config, target, blocks);
        if (deployment !== undefined) asBuilt.deployment = deployment;
        if (blocks !== undefined) asBuilt.queues = deriveQueues(config, target, blocks, deployment);
        process.stdout.write(`${JSON.stringify(asBuilt, null, 2)}\n`);
      } catch (error) {
        if (
          error instanceof ConfigError ||
          error instanceof StructurizrError ||
          error instanceof DeriveError ||
          error instanceof IacError
        ) {
          this.error(`error: ${error.message}`);
        }
        throw error;
      }
    });
}
