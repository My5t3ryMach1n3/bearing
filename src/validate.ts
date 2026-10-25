import { join, posix } from "node:path";
import { Command } from "commander";
import { ConfigError, loadConfig } from "./config.js";
import { loadModel } from "./diff.js";
import { dynamicViewKey, type Model } from "./model.js";
import { leafStories, loadRequirements, RequirementsError, type Requirement } from "./requirements.js";
import { StructurizrError } from "./structurizr.js";

// One broken Bearing rule. This is the JSON `bearing validate --json` prints for `bearing check` to read.
export interface Problem {
  rule: "requirements" | "path" | "dynamic-view" | "step";
  // Stable ID of the element, relationship or dynamic view at fault, or the issue missing a view, e.g. "#2".
  id: string;
  message: string;
}

// Checks the target against Bearing's rules. Structurizr has already checked it against C4's while loading it.
export function validateModel(model: Model, requirements: Requirement[]): Problem[] {
  return [
    ...checkRequirements(model, requirements),
    ...checkPaths(model),
    ...checkDynamicViews(model, requirements),
    ...checkSteps(model),
  ];
}

// Every element and relationship lists at least one open requirement, and nothing that isn't a requirement.
function checkRequirements(model: Model, requirements: Requirement[]): Problem[] {
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const problems: Problem[] = [];
  const items = [
    ...[...model.elements.values()].map((element) => ({ item: element, what: element.type })),
    // Relationships between deployment elements belong to the infrastructure, not to any requirement.
    ...[...model.relationships.values()]
      .filter((relationship) => model.elements.has(relationship.source))
      .map((relationship) => ({ item: relationship, what: "relationship" })),
  ];
  for (const { item, what } of items) {
    const unknown = item.requirements.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      problems.push({
        rule: "requirements",
        id: item.id,
        message: `"bearing.requirements" lists ${unknown.map((id) => `"${id}"`).join(", ")}, which ${unknown.length === 1 ? "isn't a requirement" : "aren't requirements"}; list issues as "#<n>"`,
      });
    }
    if (!item.requirements.some((id) => byId.get(id)?.state === "open")) {
      problems.push({
        rule: "requirements",
        id: item.id,
        message: `${what} serves no open requirement; set "bearing.requirements" to the open issues it serves, e.g. "#1,#2", or remove it`,
      });
    }
  }
  return problems;
}

// Every component owns a folder, and no folder is owned twice: one path can't sit inside another.
function checkPaths(model: Model): Problem[] {
  const problems: Problem[] = [];
  const owned: Array<{ id: string; path: string }> = [];
  for (const component of model.elements.values()) {
    if (component.type !== "component") continue;
    const path = normalizePath(component.path ?? "");
    if (path === "") {
      problems.push({
        rule: "path",
        id: component.id,
        message: 'component has no "bearing.path"; set it to the folder it owns, relative to the repo root',
      });
    } else if (posix.isAbsolute(path) || /^[A-Za-z]:/.test(path) || path === ".." || path.startsWith("../")) {
      problems.push({
        rule: "path",
        id: component.id,
        message: `"bearing.path" "${component.path}" is outside the repo; give a folder relative to the repo root`,
      });
    } else {
      for (const other of owned) {
        if (within(path, other.path) || within(other.path, path)) {
          problems.push({
            rule: "path",
            id: component.id,
            message: `"bearing.path" "${path}" overlaps ${other.id}'s "${other.path}"; no two components may own the same files`,
          });
        }
      }
      owned.push({ id: component.id, path });
    }
  }
  return problems;
}

function normalizePath(path: string): string {
  const trimmed = path.trim().replaceAll("\\", "/");
  return trimmed === "" ? "" : posix.normalize(trimmed).replace(/(.)\/$/, "$1");
}

function within(path: string, folder: string): boolean {
  return folder === "." || path === folder || path.startsWith(`${folder}/`);
}

// Every open story has exactly one dynamic view, keyed "req-<n>", and every dynamic view belongs to a story.
function checkDynamicViews(model: Model, requirements: Requirement[]): Problem[] {
  const problems: Problem[] = [];
  for (const story of leafStories(requirements)) {
    const key = dynamicViewKey(story.number);
    if (!model.dynamicViews.has(key)) {
      problems.push({
        rule: "dynamic-view",
        id: story.id,
        message: `open story has no dynamic view; add one keyed "${key}" and titled "${story.id} ${story.title}"`,
      });
    }
  }
  const byNumber = new Map(requirements.map((requirement) => [requirement.number, requirement]));
  for (const view of model.dynamicViews.values()) {
    const number = /^req-(\d+)$/.exec(view.id)?.[1];
    const requirement = number === undefined ? undefined : byNumber.get(Number(number));
    let message: string | undefined;
    if (number === undefined) {
      message = `dynamic view isn't keyed to a requirement; key each story's one view "${dynamicViewKey(2)}" for #2`;
    } else if (requirement === undefined) {
      message = `dynamic view is for #${number}, which isn't a requirement`;
    } else if (requirement.epic) {
      message = `dynamic view is for ${requirement.id}, an epic; epics get none, their stories each get one`;
    }
    if (message !== undefined) problems.push({ rule: "dynamic-view", id: view.id, message });
  }
  return problems;
}

// Every dynamic view step follows a relationship declared in the model, not one Structurizr implies from it.
function checkSteps(model: Model): Problem[] {
  const declared = new Set(
    [...model.relationships.values()].map((relationship) => `${relationship.source}->${relationship.destination}`),
  );
  const problems: Problem[] = [];
  for (const view of model.dynamicViews.values()) {
    for (const step of view.steps) {
      const pair = `${step.source}->${step.destination}`;
      if (!declared.has(pair)) {
        problems.push({
          rule: "step",
          id: view.id,
          message: `step ${step.order} ${pair} follows no declared relationship; declare ${pair} in the model, or route the step along relationships that exist`,
        });
      }
    }
  }
  return problems;
}

export function formatProblems(model: string, problems: Problem[]): string {
  const lines = [`${model} breaks ${problems.length} Bearing ${problems.length === 1 ? "rule" : "rules"}:`];
  for (const problem of problems) lines.push(`  - ${problem.id}: ${problem.message}`);
  return lines.join("\n");
}

export function validateCommand(): Command {
  return new Command("validate")
    .description(
      "check the target against Structurizr's validation and Bearing's rules; exits non-zero if it breaks any",
    )
    .option("--json", "print the problems as JSON instead of text")
    .action(async function (this: Command, options: { json?: boolean }) {
      try {
        const config = loadConfig();
        const requirements = await loadRequirements(config);
        const model = await loadModel(join(config.root, config.model), () => config);
        const problems = validateModel(model, requirements);
        if (options.json === true) process.stdout.write(`${JSON.stringify({ problems }, null, 2)}\n`);
        if (problems.length > 0) {
          this.error(`error: ${formatProblems(config.model, problems)}`);
        }
        if (options.json !== true) {
          const stories = leafStories(requirements).length;
          process.stdout.write(
            `${config.model} is valid: ${model.elements.size} elements and ${stories} open ${stories === 1 ? "story" : "stories"}, each with its dynamic view\n`,
          );
        }
      } catch (error) {
        if (error instanceof ConfigError || error instanceof StructurizrError || error instanceof RequirementsError) {
          this.error(`error: ${error.message}`);
        }
        throw error;
      }
    });
}
