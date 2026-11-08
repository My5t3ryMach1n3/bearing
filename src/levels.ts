import type { Drift, FieldChange, ModelDiff } from "./diff.js";
import type { Mark } from "./mermaid.js";
import type { Element, Model } from "./model.js";

// The C4 levels of the target, and how a relationship between any two elements reads at each. The PR comment's
// diagrams (target-change.ts) and the architecture page (page-data.ts) both draw from here, so the two can't disagree
// about what a level shows or what the PR changes on it.
//
// The levels, as C4 draws them: the system context, one containers diagram per software system that has containers,
// and one components diagram per container that has components.

export type LevelKind = "context" | "containers" | "components";

export interface Level {
  // "context", or the stable ID of the software system or container the level opens.
  id: string;
  kind: LevelKind;
  // The element the level opens; undefined for the system context.
  scope?: Element;
  // The level the scope is drawn on: "context" for a software system, its system for a container.
  parent?: string;
  // The element that stands for `id` at this level: inside the scope, its ancestor just below the scope; outside it,
  // its ancestor where its chain of parents leaves the scope's. Undefined for the scope itself, what holds it and an
  // element neither model has.
  at: (id: string) => string | undefined;
  // Whether an element drawn at this level sits inside the scope. Everything does at the system context.
  inside: (id: string) => boolean;
}

// The levels of one or more models, e.g. the target before and after a PR. An element in either counts.
export function levelsOf(...models: Model[]): Level[] {
  const elements = new Map(models.flatMap((model) => [...model.elements]));
  const chains = new Map<string, string[]>();
  const chain = (id: string): string[] => {
    const known = chains.get(id);
    if (known !== undefined) return known;
    const ids: string[] = [];
    for (let at = elements.get(id); at !== undefined && !ids.includes(at.id); at = elementOf(at.parent)) {
      ids.unshift(at.id);
    }
    chains.set(id, ids);
    return ids;
  };
  const elementOf = (id: string | undefined) => (id === undefined ? undefined : elements.get(id));
  const parents = new Set([...elements.values()].flatMap((each) => each.parent ?? []));

  const level = (scope?: Element): Level => {
    const scopeChain = scope === undefined ? [] : chain(scope.id);
    const at = (id: string) => {
      const ids = chain(id);
      if (ids.length === 0) return undefined;
      if (scope !== undefined && ids.includes(scope.id)) return ids[ids.indexOf(scope.id) + 1];
      const split = ids.findIndex((each, index) => each !== scopeChain[index]);
      return split === -1 ? undefined : ids[split];
    };
    if (scope === undefined) return { id: "context", kind: "context", at, inside: () => true };
    return {
      id: scope.id,
      kind: scope.type === "softwareSystem" ? "containers" : "components",
      scope,
      parent: scope.parent ?? "context",
      at,
      inside: (id) => elements.get(id)?.parent === scope.id,
    };
  };
  const scopes = [...elements.values()].filter(
    (each) => (each.type === "softwareSystem" || each.type === "container") && parents.has(each.id),
  );
  // Containers before components, so a level comes after the one it opens from.
  return [
    level(),
    ...scopes.filter((each) => each.type === "softwareSystem").map(level),
    ...scopes.filter((each) => each.type === "container").map(level),
  ];
}

export interface LevelEdge {
  source: string;
  destination: string;
  // Every relationship lifted onto the edge, in the model's order.
  relationships: string[];
  // The relationship that joins the two elements directly, rather than being lifted from below them, if any.
  direct?: string;
  // The direct relationship's description, or failing one the first relationship's.
  label: string;
}

export const pairKey = (edge: { source: string; destination: string }) => `${edge.source}->${edge.destination}`;

// The model's relationships as they read at a level, one edge per pair of elements, keyed by `pairKey`. As C4 draws
// a level, it holds what's inside the scope and what those connect to, and every relationship between them: one inside
// a single element, or with an end the level doesn't hold, isn't drawn there.
export function edgesAt(model: Model, level: Level): Map<string, LevelEdge> {
  const lifted = [...model.relationships.values()]
    .filter((relationship) => model.elements.has(relationship.source) && model.elements.has(relationship.destination))
    .flatMap((relationship) => {
      const ends = lift(level, relationship);
      return ends === undefined ? [] : [{ relationship, ends }];
    });
  const held = new Set(
    lifted.flatMap(({ ends }) =>
      level.inside(ends.source) || level.inside(ends.destination) ? [ends.source, ends.destination] : [],
    ),
  );
  const edges = new Map<string, LevelEdge>();
  for (const { relationship, ends } of lifted) {
    if (!held.has(ends.source) || !held.has(ends.destination)) continue;
    const key = pairKey(ends);
    const edge: LevelEdge = edges.get(key) ?? { ...ends, relationships: [], label: relationship.description };
    edge.relationships.push(relationship.id);
    const isDirect = ends.source === relationship.source && ends.destination === relationship.destination;
    if (isDirect && edge.direct === undefined) {
      edge.direct = relationship.id;
      edge.label = relationship.description;
    }
    edges.set(key, edge);
  }
  return edges;
}

// The elements a level holds in a model: what's inside its scope, and what anything inside it connects to.
export function elementsAt(model: Model, level: Level): Set<string> {
  const held = new Set([...model.elements.keys()].filter((id) => level.at(id) === id && level.inside(id)));
  for (const edge of edgesAt(model, level).values()) held.add(edge.source).add(edge.destination);
  return held;
}

// Where a relationship between two elements is drawn at a level, if the level draws both ends apart.
export function lift(
  level: Level,
  relationship: { source: string; destination: string },
): { source: string; destination: string } | undefined {
  const source = level.at(relationship.source);
  const destination = level.at(relationship.destination);
  if (source === undefined || destination === undefined || source === destination) return undefined;
  return { source, destination };
}

// A change to anything but the requirements an item lists. A change to those alone isn't a change to the design.
export const realChanges = (drift: Drift): FieldChange[] =>
  drift.changes.filter((change) => change.field !== "requirements");

// What the PR does to each item: added, removed, or changed with the fields it changes.
export interface ItemMark {
  mark: Exclude<Mark, "drifted">;
  changes?: FieldChange[];
}

export function itemMarks(changes: { added: { id: string }[]; removed: { id: string }[]; drifted: Drift[] }) {
  const marks = new Map<string, ItemMark>();
  for (const each of changes.added) marks.set(each.id, { mark: "added" });
  for (const each of changes.removed) marks.set(each.id, { mark: "removed" });
  for (const drift of changes.drifted) {
    const real = realChanges(drift);
    if (real.length > 0) marks.set(drift.id, { mark: "changed", changes: real });
  }
  return marks;
}

export interface MarkedLevel {
  // The elements drawn at this level that the PR adds, removes or changes.
  elements: Map<string, Exclude<Mark, "drifted">>;
  // Every edge either side of the PR draws at this level, keyed by `pairKey`, with what the PR does to it: added when
  // only the after side draws it, removed when only the before side does, and changed when the relationship that
  // joins its ends directly changes.
  edges: Map<string, LevelEdge & { mark?: Exclude<Mark, "drifted"> }>;
}

// What the PR changes on a level.
export function markLevel(level: Level, before: Model, after: Model, diff: ModelDiff): MarkedLevel {
  const elementMarks = itemMarks(diff.elements);
  const relationshipMarks = itemMarks(diff.relationships);
  const beforeEdges = edgesAt(before, level);
  const afterEdges = edgesAt(after, level);

  const elements = new Map<string, Exclude<Mark, "drifted">>();
  for (const id of new Set([...before.elements.keys(), ...after.elements.keys()])) {
    const mark = elementMarks.get(id)?.mark;
    if (level.at(id) === id && mark !== undefined) elements.set(id, mark);
  }
  const edges: MarkedLevel["edges"] = new Map();
  for (const key of new Set([...beforeEdges.keys(), ...afterEdges.keys()])) {
    const inBefore = beforeEdges.get(key);
    const inAfter = afterEdges.get(key);
    const edge = inAfter ?? inBefore!;
    const relationships = [...new Set([...(inBefore?.relationships ?? []), ...(inAfter?.relationships ?? [])])];
    const mark =
      inBefore === undefined
        ? "added"
        : inAfter === undefined
          ? "removed"
          : edge.direct !== undefined && relationshipMarks.get(edge.direct)?.mark === "changed"
            ? "changed"
            : undefined;
    edges.set(key, { ...edge, relationships, ...(mark === undefined ? {} : { mark }) });
  }
  return { elements, edges };
}
