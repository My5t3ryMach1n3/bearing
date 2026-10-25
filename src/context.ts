import { join } from "node:path";
import { Command } from "commander";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { loadModel } from "./diff.js";
import { dynamicViewKey, type DynamicView, type Element, type Model, type Relationship } from "./model.js";
import { loadRequirements, RequirementsError, type Requirement } from "./requirements.js";
import { StructurizrError } from "./structurizr.js";

// What `bearing context --issues` gives an agent to design the target from.
export interface DesignContext {
  // Open requirements, epics included so stories can be grouped under them.
  requirements: Requirement[];
  rules: { c4: string[]; bearing: string[]; dsl: string[] };
  // A DSL snippet showing the conventions in use.
  example: string;
}

// What `bearing context #<n>` gives an agent to code one issue within the target.
export interface IssueContext {
  requirement: Requirement;
  // The test tag for each criterion, in the configured format, e.g. "#2/AC1".
  tags: string[];
  // Components the issue lists or its dynamic view passes through: where its code goes.
  components: Element[];
  // Everything else it lists or passes through: people, systems and containers.
  elements: Element[];
  // Relationships it lists or its dynamic view takes: the only dependencies its code may add between components.
  relationships: Relationship[];
  dynamicView: DynamicView | null;
  // Open stories under it, when it is an epic.
  stories: number[];
}

export function designContext(config: Config, requirements: Requirement[]): DesignContext {
  const tag = testTag(config, 2, 1);
  return {
    requirements: requirements.filter((requirement) => requirement.state === "open"),
    rules: {
      c4: [
        "Model levels 1 to 3 only: people and software systems, the containers of the system being built, and the components inside its containers. Code (level 4) is tied to components by path, not modelled.",
        'Systems you don\'t build are software systems tagged "External", with no containers.',
        "A container is something that runs or stores data on its own: an app, a service, a database. A component is a group of code inside one container.",
        'Relationships are one-way and say what the source does, e.g. "Loads and saves baskets using". Give a technology where a call crosses a network, e.g. "JSON/HTTPS".',
        "Deployment views place container instances on deployment nodes, matching the infrastructure the IaC will declare.",
      ],
      bearing: [
        'Every element and relationship sets "bearing.requirements" to the open issues it serves, e.g. "#1,#2". Nothing is added just in case.',
        'Every component sets "bearing.path" to the folder it owns, relative to the repo root. No two paths overlap, and every source file belongs under one.',
        `Every open story that isn't an epic has exactly one dynamic view, keyed "${dynamicViewKey(2)}" for #2 and titled with the issue: "#2 <title>". Epics get none.`,
        "Every dynamic view step follows a relationship declared in the model.",
        "Code in one component may only depend on another along a declared relationship; anything goes inside a component.",
        `Each criterion is proven by an integration test tagged with it, e.g. "${tag}", whose trace must follow the issue's dynamic view.`,
      ],
      dsl: [
        `The model is ${config.model}, in Structurizr DSL.`,
        "Give every element an identifier in camelCase, e.g. basketService. Identifiers are stable IDs: renaming one reads as a removal and an addition.",
        "Bearing's settings are Structurizr properties: put them in a properties block on the element or relationship.",
        "Scope each dynamic view to the container its components are in.",
      ],
    },
    example: `basketService = component "Basket service" {
  description "Adds, removes and persists basket items"
  properties {
    "bearing.path" "src/basket-api/basket-service"
    "bearing.requirements" "#1,#2"
  }
}

basketService -> basketRepository "Loads and saves baskets using" {
  properties {
    "bearing.requirements" "#1,#2"
  }
}

dynamic basketApi "${dynamicViewKey(2)}" "#2 Add an item to the basket" {
  webApp -> basketController "POST /basket/items"
  basketController -> basketService "addItem()"
  basketService -> basketRepository "save()"
}`,
  };
}

// The slice of the model an issue touches: everything that lists it, plus what its dynamic view passes through.
export function issueContext(config: Config, model: Model, requirements: Requirement[], number: number): IssueContext {
  const requirement = requirements.find((each) => each.number === number);
  if (requirement === undefined) {
    throw new RequirementsError([
      `#${number} is not a requirement: no issue with that number has the "${config.requirements.label}" label`,
    ]);
  }
  const dynamicView = model.dynamicViews.get(dynamicViewKey(number)) ?? null;
  const steps = new Set((dynamicView?.steps ?? []).map((step) => `${step.source}->${step.destination}`));
  const ids = new Set<string>();
  for (const step of dynamicView?.steps ?? []) ids.add(step.source).add(step.destination);
  const lists = (item: { requirements: string[] }) => item.requirements.includes(requirement.id);

  const elements = [...model.elements.values()].filter((element) => lists(element) || ids.has(element.id));
  const relationships = [...model.relationships.values()].filter(
    (relationship) =>
      model.elements.has(relationship.source) &&
      (lists(relationship) || steps.has(`${relationship.source}->${relationship.destination}`)),
  );
  return {
    requirement,
    tags: requirement.criteria.map((criterion) => testTag(config, number, criterion.number)),
    components: elements.filter((element) => element.type === "component"),
    elements: elements.filter((element) => element.type !== "component"),
    relationships,
    dynamicView,
    stories: requirements.filter((each) => each.parent === number && each.state === "open").map((each) => each.number),
  };
}

function testTag(config: Config, issue: number, criterion: number): string {
  return config.tests.tag.replaceAll("<issue>", String(issue)).replaceAll("<n>", String(criterion));
}

export function formatDesignContext(context: DesignContext): string {
  const stories = context.requirements.filter((requirement) => !requirement.epic);
  const lines = [
    `Open requirements: ${stories.length} ${stories.length === 1 ? "story" : "stories"}, each needing one dynamic view`,
    "",
  ];
  for (const requirement of context.requirements) {
    if (requirement.epic) {
      const children = context.requirements.filter((each) => each.parent === requirement.number);
      lines.push(`${requirement.id} ${requirement.title} (epic of ${children.map((each) => each.id).join(", ")})`);
      if (requirement.story !== "") lines.push(indent(requirement.story));
    } else {
      const epic = requirement.parent === null ? "" : ` (in epic #${requirement.parent})`;
      lines.push(`${requirement.id} ${requirement.title}${epic}`, indent(requirement.story));
      for (const criterion of requirement.criteria) lines.push(`  ${criterion.id} ${criterion.text}`);
    }
    lines.push("");
  }
  if (context.requirements.length === 0) lines.push("None.", "");
  lines.push(
    "C4 rules",
    ...bullets(context.rules.c4),
    "",
    "Bearing rules (`bearing validate` checks the model against these)",
    ...bullets(context.rules.bearing),
    "",
    "DSL conventions",
    ...bullets(context.rules.dsl),
    "",
    "Example",
    indent(context.example),
  );
  return `${lines.join("\n")}\n`;
}

export function formatIssueContext(context: IssueContext): string {
  const { requirement } = context;
  const state = requirement.state === "open" ? "" : ` (closed: ${requirement.stateReason ?? "completed"})`;
  const lines = [`${requirement.id} ${requirement.title}${state}`];
  if (requirement.story !== "") lines.push(indent(requirement.story));
  lines.push("");

  if (requirement.epic) {
    lines.push(
      `An epic: it gets no dynamic view, and its code is written under its stories.`,
      `Open stories: ${context.stories.map((n) => `#${n}`).join(", ") || "none"}. Run \`bearing context #<n>\` for each.`,
    );
    return `${lines.join("\n")}\n`;
  }

  if (requirement.criteria.length > 0) {
    lines.push("Acceptance criteria (tag at least one integration test with each)");
    requirement.criteria.forEach((criterion, index) => lines.push(`  ${context.tags[index]} ${criterion.text}`));
    lines.push("");
  }

  if (context.dynamicView === null) {
    lines.push(
      `Dynamic view: none. The target has no "${dynamicViewKey(requirement.number)}" view, so it doesn't cover ${requirement.id} yet;`,
      "propose a target change before coding it.",
      "",
    );
  } else {
    const view = context.dynamicView;
    const scope = view.scope === undefined ? "" : ` in ${view.scope}`;
    lines.push(`Dynamic view ${view.id}${scope}: the path ${requirement.id}'s tests must take`);
    for (const step of view.steps)
      lines.push(`  ${step.order}. ${step.source} -> ${step.destination}  ${step.description}`);
    lines.push("");
  }

  lines.push(`Components (keep ${requirement.id}'s code inside these paths)`);
  for (const component of context.components) {
    lines.push(`  ${component.id}  ${component.path ?? "(no bearing.path)"}`);
    lines.push(`    ${component.name}${component.description === "" ? "" : `: ${component.description}`}`);
  }
  if (context.components.length === 0) lines.push("  None.");
  lines.push("");

  if (context.elements.length > 0) {
    lines.push("Other elements");
    for (const element of context.elements) {
      const parent = element.parent === undefined ? "" : ` in ${element.parent}`;
      const tags = element.tags.length === 0 ? "" : ` [${element.tags.join(", ")}]`;
      lines.push(`  ${element.id}  ${element.type}${parent}${tags}: ${element.name}`);
    }
    lines.push("");
  }

  lines.push("Relationships (code may only depend across components along these)");
  for (const relationship of context.relationships) {
    const technology = relationship.technology === "" ? "" : ` [${relationship.technology}]`;
    lines.push(
      `  ${relationship.source} -> ${relationship.destination}  ${relationship.description}${technology}`.trimEnd(),
    );
  }
  if (context.relationships.length === 0) lines.push("  None.");
  return `${lines.join("\n")}\n`;
}

function bullets(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}

export function contextCommand(): Command {
  return new Command("context")
    .description("print what an agent needs: the open requirements and rules to design from, or one issue's slice")
    .argument("[issue]", 'the issue to print the slice of the model for, e.g. "#2"')
    .option("--issues", "print the open requirements, the C4 rules and the DSL conventions, for designing the target")
    .option("--json", "print JSON instead of text")
    .action(async function (this: Command, issue: string | undefined, options: { issues?: boolean; json?: boolean }) {
      if ((issue === undefined) === (options.issues !== true)) {
        // An unquoted #2 is a shell comment, so `bearing context #2` arrives here with no issue.
        this.error(
          "error: give either --issues or an issue number, e.g. `bearing context 2` or `bearing context '#2'`",
        );
      }
      const number = issue === undefined ? undefined : /^#?(\d+)$/.exec(issue.trim())?.[1];
      if (issue !== undefined && number === undefined) this.error(`error: "${issue}" is not an issue number, e.g. #2`);
      try {
        const config = loadConfig();
        const requirements = await loadRequirements(config);
        let output: { json: unknown; text: string };
        if (number === undefined) {
          const context = designContext(config, requirements);
          output = { json: context, text: formatDesignContext(context) };
        } else {
          const model = await loadModel(join(config.root, config.model), () => config);
          const context = issueContext(config, model, requirements, Number(number));
          output = { json: context, text: formatIssueContext(context) };
        }
        process.stdout.write(options.json === true ? `${JSON.stringify(output.json, null, 2)}\n` : output.text);
      } catch (error) {
        if (error instanceof ConfigError || error instanceof StructurizrError || error instanceof RequirementsError) {
          this.error(`error: ${error.message}`);
        }
        throw error;
      }
    });
}
