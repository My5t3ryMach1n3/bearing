import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { Command } from "commander";
import { ConfigError, loadConfig, type Config } from "./config.js";
import {
  modelFromWorkspace,
  type DeploymentElement,
  type DynamicView,
  type Element,
  type Model,
  type Relationship,
} from "./model.js";
import { loadWorkspace, StructurizrError, type Workspace } from "./structurizr.js";

// What changed between two models, by stable ID. This is the JSON `bearing diff` prints for other commands to read.
export interface ModelDiff {
  elements: Changes<Element>;
  relationships: Changes<Relationship>;
  dynamicViews: Changes<DynamicView>;
  deployment: Changes<DeploymentElement>;
}

export interface Changes<T> {
  added: T[];
  removed: T[];
  // In both models, with different fields.
  drifted: Drift[];
}

export interface Drift {
  id: string;
  changes: FieldChange[];
}

export interface FieldChange {
  field: string;
  // Absent when the field is unset on that side, e.g. a component that gains a `bearing.path`.
  from?: unknown;
  to?: unknown;
}

// Diffs `before` (e.g. the target) against `after` (e.g. the as-built model). Every list is sorted by ID.
export function diffModels(before: Model, after: Model): ModelDiff {
  return {
    elements: diffMaps(before.elements, after.elements),
    relationships: diffMaps(before.relationships, after.relationships),
    dynamicViews: diffMaps(before.dynamicViews, after.dynamicViews),
    deployment: diffMaps(before.deployment, after.deployment),
  };
}

function diffMaps<T extends { id: string }>(before: Map<string, T>, after: Map<string, T>): Changes<T> {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const added = [...after.values()].filter((item) => !before.has(item.id)).sort(byId);
  const removed = [...before.values()].filter((item) => !after.has(item.id)).sort(byId);
  const drifted: Drift[] = [];
  for (const [id, old] of before) {
    const current = after.get(id);
    if (current === undefined) continue;
    const fields = [...new Set([...Object.keys(old), ...Object.keys(current)])].sort();
    const changes = fields.flatMap((field): FieldChange[] => {
      const from = (old as Record<string, unknown>)[field];
      const to = (current as Record<string, unknown>)[field];
      if (equal(from, to)) return [];
      const change: FieldChange = { field };
      if (from !== undefined) change.from = from;
      if (to !== undefined) change.to = to;
      return [change];
    });
    if (changes.length > 0) drifted.push({ id, changes });
  }
  return { added, removed, drifted: drifted.sort(byId) };
}

// Model values are plain data: strings, arrays and objects of them. Object keys compare in any order.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
}

// Loads a model from a workspace DSL file, via Structurizr, or from workspace JSON it already exported.
export async function loadModel(file: string, config: () => Config): Promise<Model> {
  if (file.endsWith(".json")) return modelFromWorkspace(JSON.parse(await readFile(file, "utf8")) as Workspace);
  const loaded = config();
  return modelFromWorkspace(await loadWorkspace({ ...loaded, model: relative(loaded.root, resolve(file)) }));
}

export function diffCommand(): Command {
  return new Command("diff")
    .description("print, as JSON, what changed between two models: added, removed and drifted, by stable ID")
    .argument("<before>", "workspace DSL, or workspace JSON exported by Structurizr")
    .argument("<after>", "workspace DSL, or workspace JSON exported by Structurizr")
    .action(async function (this: Command, before: string, after: string) {
      for (const file of [before, after]) if (!existsSync(file)) this.error(`error: ${file} not found`);
      let config: Config | undefined;
      const lazyConfig = () => (config ??= loadConfig());
      try {
        const diff = diffModels(await loadModel(before, lazyConfig), await loadModel(after, lazyConfig));
        process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
      } catch (error) {
        if (error instanceof ConfigError || error instanceof StructurizrError) this.error(`error: ${error.message}`);
        if (error instanceof SyntaxError) this.error(`error: not valid workspace JSON: ${error.message}`);
        throw error;
      }
    });
}
