import { diffModels, type Changes, type Drift, type FieldChange, type ModelDiff } from "./diff.js";
import {
  formatMermaid,
  formatSequence,
  type Mark,
  type Overlay,
  type OverlayEdge,
  type OverlayNode,
} from "./mermaid.js";
import type { DeploymentElement, DynamicView, Element, Model, Relationship } from "./model.js";

// The target-change section of the PR comment: what a PR changes about the architecture, in the order a reviewer
// reads it. A summary in plain words, one diagram per C4 level that changed, a sequence diagram per new or changed
// dynamic view, the model diff, then the ADRs. A first design isn't a diff, so it's drawn as the model's own views. A
// change only to the requirements an item lists is collapsed to one line and left out of the diagrams. See the How
// `bearing report` works section of docs/product-spec.md.

export interface Adr {
  path: string;
  text: string;
}

// A diagram stops adding neighbours once it has this many elements. What the PR changes is always drawn.
export const diagramLimit = 15;
// Past this many sequence diagrams, every one is folded.
const openSequences = 3;
// How many relationships the summary spells out.
const summaryRelationships = 6;

export const kinds = {
  person: "Person",
  softwareSystem: "Software system",
  container: "Container",
  component: "Component",
  deploymentNode: "Deployment node",
  infrastructureNode: "Infrastructure node",
  containerInstance: "Container instance",
  softwareSystemInstance: "Software system instance",
};

export function describeKind(kind: string, technology: string): string {
  return technology === "" ? kind : `${kind}: ${technology}`;
}

// Text for a Markdown table cell, where a pipe would end the cell and a newline the row.
export function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

interface Diagram {
  heading: string;
  overlay: Overlay;
  // Neighbours dropped to stay within `diagramLimit`.
  leftOut: number;
}

// A change to anything but the requirements an item lists.
const realChanges = (drift: Drift): FieldChange[] => drift.changes.filter((change) => change.field !== "requirements");
const realDrift = (changes: Drift[]) => new Set(changes.filter((drift) => realChanges(drift).length > 0).map(idOf));
const idOf = (item: { id: string }) => item.id;

// One level of the model as a diagram sees it. `at` lifts an element to the one that stands for it at this level, or
// gives undefined if the level doesn't draw it.
interface Level {
  heading: string;
  firstHeading: string;
  at: (id: string) => string | undefined;
  group: (element: Element) => string | undefined;
  // An edge to draw must touch one of these, when given.
  focus?: (id: string) => boolean;
}

// The target's levels: the system context, the containers, and the components of each container.
function levels(before: Model, after: Model): Level[] {
  const element = (id: string) => after.elements.get(id) ?? before.elements.get(id);
  const all = [...new Map([...before.elements, ...after.elements]).values()];
  const systemsWithContainers = new Set(all.filter((each) => each.type === "container").map((each) => each.parent));
  const nameOf = (id: string | undefined) => (id === undefined ? undefined : element(id)?.name);

  const root = (id: string): string | undefined => {
    const found = element(id);
    if (found === undefined) return undefined;
    return found.parent === undefined ? id : root(found.parent);
  };
  const container = (id: string): string | undefined => {
    const found = element(id);
    if (found === undefined) return undefined;
    if (found.type === "component") return found.parent;
    return found.type === "softwareSystem" && systemsWithContainers.has(id) ? undefined : id;
  };
  const scopes = all.filter(
    (each) => each.type === "container" && all.some((other) => other.type === "component" && other.parent === each.id),
  );
  return [
    {
      heading: "System context: what changes",
      firstHeading: "System context",
      at: root,
      group: () => undefined,
    },
    {
      heading: "Containers: what changes",
      firstHeading: "Containers",
      at: container,
      group: (each) => (each.type === "container" ? nameOf(each.parent) : undefined),
    },
    ...scopes.map((scope): Level => {
      const inScope = (id: string) => element(id)?.type === "component" && element(id)?.parent === scope.id;
      return {
        heading: `Components: what changes in ${scope.name}`,
        firstHeading: `Components of ${scope.name}`,
        at: (id) => {
          if (inScope(id)) return id;
          const lifted = container(id);
          return lifted === scope.id ? undefined : lifted;
        },
        group: (each) => (inScope(each.id) ? scope.name : undefined),
        focus: inScope,
      };
    }),
  ];
}

interface LevelEdge {
  source: string;
  destination: string;
  label: string;
  // The relationship itself when it joins the two elements directly, rather than being lifted from below them.
  direct?: string;
}

// The model's relationships as they read at a level, one per pair of elements.
function edgesAt(model: Model, level: Level): Map<string, LevelEdge> {
  const edges = new Map<string, LevelEdge>();
  for (const relationship of model.relationships.values()) {
    if (!model.elements.has(relationship.source) || !model.elements.has(relationship.destination)) continue;
    const source = level.at(relationship.source);
    const destination = level.at(relationship.destination);
    if (source === undefined || destination === undefined || source === destination) continue;
    if (level.focus !== undefined && !level.focus(source) && !level.focus(destination)) continue;
    const key = `${source}->${destination}`;
    const isDirect = source === relationship.source && destination === relationship.destination;
    const existing = edges.get(key);
    if (existing === undefined) {
      edges.set(key, {
        source,
        destination,
        label: relationship.description,
        ...(isDirect ? { direct: relationship.id } : {}),
      });
    } else if (isDirect && existing.direct === undefined) {
      existing.direct = relationship.id;
      existing.label = relationship.description;
    }
  }
  return edges;
}

// Keeps the marked elements, the ends of marked edges and then the neighbours with the most edges to them, up to
// `diagramLimit`, and the edges between what's left.
function trimmed(
  required: string[],
  neighbours: string[],
  allEdges: OverlayEdge[],
): { kept: Set<string>; edges: OverlayEdge[]; leftOut: number } {
  const kept = new Set(required);
  const links = (id: string) =>
    allEdges.filter(
      (edge) =>
        (edge.source === id && kept.has(edge.destination)) || (edge.destination === id && kept.has(edge.source)),
    ).length;
  const ranked = [...new Set(neighbours)]
    .filter((id) => !kept.has(id))
    .map((id, index) => ({ id, index, links: links(id) }))
    .sort((a, b) => b.links - a.links || a.index - b.index);
  const room = Math.max(0, diagramLimit - kept.size);
  for (const { id } of ranked.slice(0, room)) kept.add(id);
  return {
    kept,
    edges: allEdges.filter((edge) => kept.has(edge.source) && kept.has(edge.destination)),
    leftOut: Math.max(0, ranked.length - room),
  };
}

// A level's diagram: what changed there and its direct neighbours, or, for a first design, everything at that level.
// Undefined for a level with nothing to show.
function levelDiagram(level: Level, before: Model, after: Model, diff: ModelDiff, first: boolean): Diagram | undefined {
  const element = (id: string) => after.elements.get(id) ?? before.elements.get(id);
  const changedElements = realDrift(diff.elements.drifted);
  const changedRelationships = realDrift(diff.relationships.drifted);
  const beforeEdges = edgesAt(before, level);
  const afterEdges = edgesAt(after, level);

  const marks = new Map<string, Mark>();
  for (const id of new Set([...before.elements.keys(), ...after.elements.keys()])) {
    if (level.at(id) !== id) continue;
    if (!before.elements.has(id)) marks.set(id, "added");
    else if (!after.elements.has(id)) marks.set(id, "removed");
    else if (changedElements.has(id)) marks.set(id, "changed");
  }
  const edges: OverlayEdge[] = [];
  for (const [key, edge] of new Map([...beforeEdges, ...afterEdges])) {
    const mark: Mark | undefined = !beforeEdges.has(key)
      ? "added"
      : !afterEdges.has(key)
        ? "removed"
        : edge.direct !== undefined && changedRelationships.has(edge.direct)
          ? "changed"
          : undefined;
    edges.push({
      source: edge.source,
      destination: edge.destination,
      label: edge.label,
      ...(mark === undefined || first ? {} : { mark }),
    });
  }
  if (first) marks.clear();

  const inFocus = (id: string) => level.focus === undefined || level.focus(id);
  const changes = [...marks.keys()].some(inFocus) || edges.some((edge) => edge.mark !== undefined);
  let required: string[];
  let neighbours: string[];
  if (first) {
    required = [];
    neighbours = [...after.elements.keys()].filter((id) => level.at(id) === id && inFocus(id));
    neighbours.push(...edges.flatMap((edge) => [edge.source, edge.destination]));
  } else {
    if (!changes) return undefined;
    const changedHere = new Set([...marks.keys()].filter(inFocus));
    required = [...changedHere];
    required.push(
      ...edges.filter((edge) => edge.mark !== undefined).flatMap((edge) => [edge.source, edge.destination]),
    );
    neighbours = edges
      .filter((edge) => changedHere.has(edge.source) || changedHere.has(edge.destination))
      .flatMap((edge) => [edge.source, edge.destination]);
  }
  const { kept, edges: drawn, leftOut } = trimmed(required, neighbours, edges);
  if (kept.size === 0) return undefined;
  const nodes = [...kept].map((id): OverlayNode => {
    const found = element(id)!;
    const group = level.group(found);
    const mark = marks.get(id);
    return {
      id,
      name: found.name,
      kind: describeKind(kinds[found.type], found.technology),
      ...(group === undefined ? {} : { group }),
      ...(mark === undefined ? {} : { mark }),
    };
  });
  return { heading: first ? level.firstHeading : level.heading, overlay: { nodes, edges: drawn }, leftOut };
}

// Each deployment environment with something to show. A node that only holds others is the box they're drawn in.
function deploymentDiagrams(before: Model, after: Model, diff: ModelDiff, first: boolean): Diagram[] {
  const all = new Map([...before.deployment, ...after.deployment]);
  const changed = realDrift(diff.deployment.drifted);
  const relationships = new Map([...before.relationships, ...after.relationships]);
  const changedRelationships = realDrift(diff.relationships.drifted);
  const addedRelationships = new Set(diff.relationships.added.map(idOf));
  const removedRelationships = new Set(diff.relationships.removed.map(idOf));
  const parents = new Set([...all.values()].flatMap((each) => each.parent ?? []));

  return [...new Set([...all.values()].map((each) => each.environment))].sort().flatMap((environment): Diagram[] => {
    const inEnvironment = [...all.values()].filter((each) => each.environment === environment);
    const ids = new Set(inEnvironment.map(idOf));
    const marks = new Map<string, Mark>();
    if (!first) {
      for (const { id } of inEnvironment) {
        if (!before.deployment.has(id)) marks.set(id, "added");
        else if (!after.deployment.has(id)) marks.set(id, "removed");
        else if (changed.has(id)) marks.set(id, "changed");
      }
    }
    const edges = [...relationships.values()]
      .filter((relationship) => ids.has(relationship.source) && ids.has(relationship.destination))
      .map((relationship: Relationship): OverlayEdge => {
        const mark: Mark | undefined = addedRelationships.has(relationship.id)
          ? "added"
          : removedRelationships.has(relationship.id)
            ? "removed"
            : changedRelationships.has(relationship.id)
              ? "changed"
              : undefined;
        return {
          source: relationship.source,
          destination: relationship.destination,
          label: relationship.description,
          ...(mark === undefined || first ? {} : { mark }),
        };
      });
    if (!first && marks.size === 0 && edges.every((edge) => edge.mark === undefined)) return [];

    const drawable = (each: DeploymentElement) => !parents.has(each.id) || marks.has(each.id);
    const required = [
      ...marks.keys(),
      ...edges.filter((edge) => edge.mark !== undefined).flatMap((edge) => [edge.source, edge.destination]),
    ];
    const family = (id: string) =>
      inEnvironment.filter((each) => each.id !== id && (each.parent === id || each.parent === all.get(id)?.parent));
    const neighbours = first
      ? inEnvironment.filter(drawable).map(idOf)
      : [
          ...edges
            .filter((edge) => marks.has(edge.source) || marks.has(edge.destination))
            .flatMap((edge) => [edge.source, edge.destination]),
          ...[...marks.keys()].flatMap((id) => family(id).filter(drawable).map(idOf)),
        ];
    const { kept, edges: drawn, leftOut } = trimmed(required, neighbours, edges);
    const nodes = [...kept].map((id): OverlayNode => {
      const each = all.get(id)!;
      const mark = marks.get(id);
      return {
        id,
        name: each.name,
        kind: describeKind(kinds[each.type], each.technology),
        group: each.parent === undefined ? environment : (all.get(each.parent)?.name ?? environment),
        ...(mark === undefined ? {} : { mark }),
      };
    });
    return [{ heading: `Deployment: ${environment}`, overlay: { nodes, edges: drawn }, leftOut }];
  });
}

const list = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "#5" for the view "req-5".
const viewName = (view: { id: string }) => /^req-(\d+)$/.exec(view.id)?.[1]?.replace(/^/, "#") ?? view.id;

// "the Basket sharing and Email outbox components to Basket API, and the external Email provider".
function elementPhrases(items: Element[], preposition: string, model: Model): string[] {
  const phrases: string[] = [];
  for (const type of ["component", "container"] as const) {
    const byParent = new Map<string | undefined, Element[]>();
    for (const item of items.filter((each) => each.type === type)) {
      byParent.set(item.parent, [...(byParent.get(item.parent) ?? []), item]);
    }
    for (const [parent, children] of byParent) {
      const owner = parent === undefined ? undefined : model.elements.get(parent)?.name;
      phrases.push(
        `the ${list(children.map((child) => child.name))} ${children.length === 1 ? type : `${type}s`}${owner === undefined ? "" : ` ${preposition} ${owner}`}`,
      );
    }
  }
  for (const item of items.filter((each) => each.type === "softwareSystem")) {
    const owns = [...model.elements.values()].some((each) => each.parent === item.id);
    phrases.push(owns ? `the ${item.name} system` : `the external ${item.name}`);
  }
  for (const item of items.filter((each) => each.type === "person")) phrases.push(`the person ${item.name}`);
  return phrases;
}

// What the PR does to the target, in plain words, generated from the model diff.
function formatSummary(before: Model, after: Model, diff: ModelDiff): string[] {
  const nameOf = (id: string) => after.elements.get(id)?.name ?? before.elements.get(id)?.name ?? id;
  const arrow = (relationship: Relationship) =>
    `${nameOf(relationship.source)} → ${nameOf(relationship.destination)} ("${relationship.description}")`;
  const lines: string[] = [];
  const sentence = (verb: string, phrases: string[]) => {
    if (phrases.length > 0) lines.push(`${verb} ${phrases.join(", and ")}.`);
  };
  sentence("Adds", elementPhrases(diff.elements.added, "to", after));
  sentence("Removes", elementPhrases(diff.elements.removed, "from", before));
  const changes = diff.elements.drifted.flatMap((drift) => {
    const fields = realChanges(drift).map((change) => change.field);
    return fields.length === 0 ? [] : [`${nameOf(drift.id)} (${list(fields)})`];
  });
  if (changes.length > 0) lines.push(`Changes ${list(changes)}.`);
  const named = (items: Relationship[]) => {
    const shown = items.slice(0, summaryRelationships).map(arrow);
    if (items.length > shown.length) shown.push(`${items.length - shown.length} more`);
    return list(shown);
  };
  const changedRelationships = diff.relationships.drifted.flatMap((drift) => {
    const relationship = after.relationships.get(drift.id);
    return relationship !== undefined && realChanges(drift).length > 0 ? [relationship] : [];
  });
  const deploymentRelationship = (relationship: Relationship) =>
    !after.elements.has(relationship.source) && !before.elements.has(relationship.source);
  const added = diff.relationships.added.filter((each) => !deploymentRelationship(each));
  const removed = diff.relationships.removed.filter((each) => !deploymentRelationship(each));
  if (added.length > 0) lines.push(`New ${added.length === 1 ? "relationship" : "relationships"}: ${named(added)}.`);
  if (removed.length > 0) {
    lines.push(`Removed ${removed.length === 1 ? "relationship" : "relationships"}: ${named(removed)}.`);
  }
  if (changedRelationships.length > 0) {
    lines.push(
      `Changed ${changedRelationships.length === 1 ? "relationship" : "relationships"}: ${named(changedRelationships)}.`,
    );
  }
  const views = (label: string, items: Array<{ id: string }>) => {
    if (items.length > 0) {
      lines.push(`${label} dynamic ${items.length === 1 ? "view" : "views"}: ${list(items.map(viewName))}.`);
    }
  };
  views("New", diff.dynamicViews.added);
  views("Removed", diff.dynamicViews.removed);
  views(
    "Changed",
    changedViews(diff).map((id) => ({ id })),
  );
  const deployment = (verb: string, items: Array<{ name: string; type: DeploymentElement["type"] }>) => {
    const nodes = items.filter((item) => item.type === "deploymentNode" || item.type === "infrastructureNode");
    if (nodes.length > 0) {
      lines.push(`${verb} ${list(nodes.map((node) => node.name))} in the deployment.`);
    }
  };
  deployment("Adds", diff.deployment.added);
  deployment("Removes", diff.deployment.removed);
  const moved = diff.deployment.drifted.filter((drift) => realChanges(drift).length > 0);
  if (moved.length > 0) {
    const nameOfNode = (id: string) => after.deployment.get(id)?.name ?? id;
    lines.push(
      `Changes ${list(moved.map((drift) => `${nameOfNode(drift.id)} (${list(realChanges(drift).map((change) => change.field))})`))} in the deployment.`,
    );
  }
  return lines;
}

// What a first design defines, since a list of everything added would say nothing.
function formatFirstSummary(after: Model): string {
  const count = (type: Element["type"]) => [...after.elements.values()].filter((each) => each.type === type).length;
  const defined = [
    count("person") === 0 ? "" : plural(count("person"), "person", "people"),
    plural(count("softwareSystem"), "software system"),
    plural(count("container"), "container"),
    plural(count("component"), "component"),
    plural(after.dynamicViews.size, "dynamic view"),
  ].filter((part) => part !== "");
  return `This is the initial target. It defines ${list(defined)}.`;
}

// Views whose path or title changed. A refreshed criteria pin leaves the diagram as it was, so it's only in the table.
function changedViews(diff: ModelDiff): string[] {
  return diff.dynamicViews.drifted
    .filter((drift) => drift.changes.some((change) => change.field === "steps" || change.field === "description"))
    .map(idOf);
}

function mermaidBlock(source: string): string {
  return ["```mermaid", source, "```"].join("\n");
}

function formatDiagram(diagram: Diagram): string {
  const note =
    diagram.leftOut === 0
      ? []
      : ["", `${plural(diagram.leftOut, "neighbour")} left out to keep this readable; the Structurizr site has them.`];
  return [`#### ${diagram.heading}`, "", mermaidBlock(formatMermaid(diagram.overlay)), ...note].join("\n");
}

function formatView(view: DynamicView, model: Model, fallback: Model): string {
  const nameOf = (id: string) => model.elements.get(id)?.name ?? fallback.elements.get(id)?.name ?? id;
  return mermaidBlock(formatSequence(view.steps, nameOf));
}

// A sequence diagram for each new or changed dynamic view. The first is open unless there are many, or it's a first
// design, where no one view is the point.
function formatSequences(before: Model, after: Model, diff: ModelDiff, first: boolean): string[] {
  const added = diff.dynamicViews.added.map((view) => ({
    title: view.description,
    body: formatView(view, after, before),
  }));
  const changed = changedViews(diff).map((id) => {
    const view = after.dynamicViews.get(id)!;
    return {
      title: `${view.description} (changed)`,
      body: [
        "Before:",
        "",
        formatView(before.dynamicViews.get(id)!, before, after),
        "",
        "After:",
        "",
        formatView(view, after, before),
      ].join("\n"),
    };
  });
  const views = [...added, ...changed];
  return views.map(({ title, body }, index) => {
    const open = index === 0 && !first && views.length <= openSequences;
    return `<details${open ? " open" : ""}><summary>${html(title)}</summary>\n\n${body}\n\n</details>`;
  });
}

function html(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", " ");
}

// "19 elements and relationships now also serve #5."
function formatRequirementsOnly(diff: ModelDiff): string | undefined {
  const drifts = [...diff.elements.drifted, ...diff.relationships.drifted];
  const only = drifts.filter((drift) => realChanges(drift).length === 0);
  if (only.length === 0) return undefined;
  const changes = only.flatMap((drift) => drift.changes);
  const gained = new Set<string>();
  const lost = new Set<string>();
  for (const change of changes) {
    const from = (change.from ?? []) as string[];
    const to = (change.to ?? []) as string[];
    for (const issue of to) if (!from.includes(issue)) gained.add(issue);
    for (const issue of from) if (!to.includes(issue)) lost.add(issue);
  }
  const items = only.length === 1 ? "1 element or relationship" : `${only.length} elements and relationships`;
  const parts = [
    ...(gained.size > 0 ? [`now also ${only.length === 1 ? "serves" : "serve"} ${list([...gained].sort())}`] : []),
    ...(lost.size > 0 ? [`no longer ${only.length === 1 ? "serves" : "serve"} ${list([...lost].sort())}`] : []),
  ];
  return `${items} ${parts.join(" and ")}.`;
}

function formatDiffTable(diff: ModelDiff): string[] {
  const sections: Array<[string, Changes<{ id: string }>]> = [
    ["Elements", diff.elements],
    ["Relationships", diff.relationships],
    ["Dynamic views", diff.dynamicViews],
    ["Deployment", diff.deployment],
  ];
  const rows = sections.flatMap(([name, changes]) => {
    const drifted = changes.drifted.filter((drift) => realChanges(drift).length > 0);
    if (changes.added.length + changes.removed.length + drifted.length === 0) return [];
    const ids = (items: Array<{ id: string }>) => items.map((item) => `\`${cell(item.id)}\``).join(", ");
    const fields = drifted
      .map(
        (item) =>
          `\`${cell(item.id)}\` (${realChanges(item)
            .map((change) => change.field)
            .join(", ")})`,
      )
      .join(", ");
    return [`| ${name} | ${ids(changes.added)} | ${ids(changes.removed)} | ${fields} |`];
  });
  return rows.length === 0 ? [] : ["| | Added | Removed | Drifted |", "| --- | --- | --- | --- |", ...rows];
}

export interface TargetChangeOptions {
  // Leaves out the sequence diagrams, for a comment that's too long with them.
  sequences?: boolean;
}

// The section. `before` and `after` are the same object when the PR changes what surrounds the model but not the model.
export function formatTargetChange(
  before: Model,
  after: Model,
  files: string[],
  adrs: Adr[],
  options: TargetChangeOptions = {},
): string {
  const lines = [
    "### ⚠️ Target change",
    "",
    "This PR changes the target, so merging it approves the change. Read this before the code.",
    "",
    `Changed: ${files.map((file) => `\`${cell(file)}\``).join(", ")}`,
  ];
  const diff = before === after ? undefined : diffModels(before, after);
  const table = diff === undefined ? [] : formatDiffTable(diff);
  const requirementsOnly = diff === undefined ? undefined : formatRequirementsOnly(diff);
  const modelChanged = table.length > 0 || requirementsOnly !== undefined;
  const first = before.elements.size === 0 && modelChanged;

  if (diff !== undefined && modelChanged) {
    const summary = first ? [formatFirstSummary(after)] : formatSummary(before, after, diff);
    if (summary.length > 0) lines.push("", ...summary.map((line) => (first ? line : `- ${line}`)));
    const diagrams = [
      ...levels(before, after).flatMap((level) => levelDiagram(level, before, after, diff, first) ?? []),
      ...deploymentDiagrams(before, after, diff, first),
    ];
    for (const diagram of diagrams) lines.push("", formatDiagram(diagram));
    if (diagrams.length > 0 && !first) {
      lines.push("", "Only what changes at each level and its neighbours. 🟩 added · ⬜ removed, dashed · 🟨 changed");
    }
    if (options.sequences !== false) {
      const sequences = formatSequences(before, after, diff, first);
      if (sequences.length > 0) lines.push("", "#### Dynamic views", "", sequences.join("\n\n"));
    } else if (diff.dynamicViews.added.length + changedViews(diff).length > 0) {
      lines.push("", "The dynamic views are too long for the comment; the Structurizr site has them.");
    }
  }
  if (first) {
    // It lists everything, so it's folded.
    lines.push("", `<details><summary>Model diff</summary>\n\n${table.join("\n")}\n\n</details>`);
  } else if (modelChanged) {
    lines.push("", "#### Model diff");
    if (table.length > 0) lines.push("", table.join("\n"));
    if (requirementsOnly !== undefined) lines.push("", requirementsOnly);
  } else {
    lines.push("", "The model itself is unchanged.");
  }
  for (const adr of adrs) {
    const title = /^#\s+(.+)$/m.exec(adr.text)?.[1]?.trim() ?? adr.path;
    lines.push(
      "",
      `<details open><summary>${title} (<code>${adr.path}</code>)</summary>\n\n${adr.text.trim()}\n\n</details>`,
    );
  }
  if (modelChanged && adrs.length === 0) {
    lines.push("", "No ADR in this PR gives the reason for the change or the alternatives considered.");
  }
  return lines.join("\n");
}
