import { checkTitles, type CheckReport, type ClaimMismatch } from "./check.js";
import type { FileChange } from "./code-changes.js";
import type { CriterionCoverage } from "./coverage.js";
import type { ImportSite } from "./derive.js";
import { diffModels, type FieldChange, type ModelDiff } from "./diff.js";
import {
  edgesAt,
  elementsAt,
  itemMarks,
  levelsOf,
  lift,
  markLevel,
  pairKey,
  type Level,
  type LevelKind,
} from "./levels.js";
import type { DynamicStep, Element, ElementType, Model, Relationship } from "./model.js";
import { componentOf, componentPaths, normalizePath, within } from "./paths.js";
import type { QueueGrant } from "./queues.js";
import { summarise } from "./report.js";
import type { Workspace } from "./structurizr.js";
import { kinds as typeKinds, type Adr } from "./target-change.js";

// The architecture page's data: everything the page shows, built from the model, the PR's diff and the checks'
// results, with no layout. The page's script reads it as `PageData`, so this file's types are the contract between
// the two. The same inputs give the same data: every list follows the model's order or is sorted. See #116 and #118.

export type Mark = "added" | "removed" | "changed";
export type CheckId = CheckReport["checks"][number]["check"];
export type TabId = "target" | "code" | "build" | "behaviour";

// The shapes the page draws. Structurizr's other shapes are drawn as a box.
export type Shape =
  "Box" | "RoundedBox" | "Cylinder" | "Pipe" | "WebBrowser" | "MobileDevice" | "Folder" | "Hexagon" | "Person";

export interface PageData {
  // Whether the PR changes the target model. When it doesn't, Before and After are the same.
  changed: boolean;
  // Whether this is the target's first design, with nothing before it.
  first: boolean;
  // Every element either side of the PR, by stable ID, in the model's order.
  elements: Record<string, PageElement>;
  // Every relationship between elements either side of the PR, by stable ID.
  relationships: Record<string, PageRelationship>;
  // The system context first, then each software system's containers, then each container's components.
  levels: PageLevel[];
  // Relationships the code makes that the target doesn't declare, by ID.
  drift: Record<string, PageDrift>;
  // Every dynamic view either side of the PR, the ones the PR adds or changes first.
  views: PageView[];
  tabs: Record<TabId, PageTab>;
  target: TargetFindings;
  code: CodeFindings;
  build: BuildFindings;
}

export interface PageElement {
  id: string;
  type: ElementType;
  name: string;
  description: string;
  technology: string;
  // What it is, as its box names it above its name, e.g. "Database", "API" or "Component".
  kind: string;
  shape: Shape;
  // Tagged `External`: drawn grey, and says so.
  external: boolean;
  parent?: string;
  path?: string;
  requirements: string[];
  inBefore: boolean;
  inAfter: boolean;
  mark?: Mark;
  // For a changed element, each field the PR changes, from → to.
  changes?: FieldChange[];
  // The level it opens, when it has one: its own ID.
  level?: string;
  // For a component with a `bearing.path`: whether the path holds code yet. One without is drawn greyed out.
  built?: boolean;
  // The functional code the PR changes in it and everything inside it. Absent when the diff doesn't touch it.
  code?: CodeCount;
  // For a component, the files the PR changes under its path, most lines first.
  files?: FileChange[];
  // For an element with a level of its own, what sits inside it, for each tab's `… inside ›`.
  inside?: Inside;
}

export interface CodeCount {
  files: number;
  added: number;
  removed: number;
}

export interface Inside {
  // Elements inside it the PR adds, removes and changes.
  added: number;
  removed: number;
  changed: number;
  // Functional lines changed inside it, added and removed.
  lines: number;
  // Undeclared relationships with an end inside it.
  drifted: number;
}

export interface PageRelationship {
  id: string;
  source: string;
  destination: string;
  description: string;
  technology: string;
  inBefore: boolean;
  inAfter: boolean;
  mark?: Mark;
  changes?: FieldChange[];
}

export interface PageLevel {
  // "context", or the stable ID of the element it opens.
  id: string;
  kind: LevelKind;
  title: string;
  scope?: string;
  // The level the scope is drawn on.
  parent?: string;
  // Every element any mode draws at this level, so one layout serves them all: the target's either side of the PR and
  // the ends of drifted relationships.
  nodes: string[];
  edges: PageEdge[];
  drift: PageDriftEdge[];
}

export interface PageEdge {
  // `<source>-><destination>`, unique within its level.
  id: string;
  source: string;
  destination: string;
  // The relationships lifted onto it, either side of the PR.
  relationships: string[];
  // The direct relationship's description, or the first one's.
  label: string;
  inBefore: boolean;
  inAfter: boolean;
  mark?: Mark;
}

export interface PageDriftEdge {
  // `drift:<source>-><destination>`, unique within its level.
  id: string;
  source: string;
  destination: string;
  // The undeclared relationships lifted onto it.
  drift: string[];
}

export interface PageDrift {
  // "<source>-><destination>", between components or a component and a queue.
  id: string;
  source: string;
  destination: string;
  // What makes it: imports, or IAM statements that let the code send to or receive from a queue.
  via: "imports" | "send" | "receive";
  imports: ImportSite[];
  grants: Array<{ node: string; role: string; policy: string; file: string; line: number; actions: string[] }>;
  // The elements the target routes it through instead, when it declares a path of two relationships between its ends.
  through: string[];
}

export interface PageCheck {
  check: CheckId;
  title: string;
  status: "passed" | "failed" | "skipped" | "flagged";
  blocking: boolean;
  // One line on what it found, as the PR comment's table says it.
  summary: string;
}

export interface PageTab {
  // Its result in a few words, e.g. "+3 ~1", "+283 −9", "1 undeclared" or "no change".
  counter: string;
  // Whether it needs the reviewer: one of its checks failed or was flagged. Its counter is red.
  attention: boolean;
  // The checks it holds, in reading order.
  checks: PageCheck[];
}

export interface TargetFindings {
  // The files the PR changes that make it a target change.
  files: string[];
  adrs: PageAdr[];
}

export interface PageAdr {
  path: string;
  title: string;
  // The ADR's Context: what forced the choice.
  reason: string;
  decision: string;
  alternatives: string;
}

export interface CodeFindings {
  // Everything the PR changes in functional code, outside the model included.
  total: CodeCount;
  // Components with changes, most lines first.
  components: string[];
  // Functional files no component's path holds, most lines first.
  outside: FileChange[];
}

export interface BuildFindings {
  // The undeclared relationships, in the checks' order.
  drift: string[];
  claim: { status: PageCheck["status"]; file?: string; mismatches: ClaimMismatch[] };
  deployment: { status: PageCheck["status"]; summary: string };
}

export interface PageView {
  // "req-5"
  id: string;
  // "#5", for a view keyed by its issue.
  issue?: string;
  title: string;
  scope?: string;
  // The level its steps are drawn on.
  level: string;
  mark?: Mark;
  changes?: FieldChange[];
  inBefore: boolean;
  inAfter: boolean;
  // Its steps after the PR, or before it for a view the PR removes.
  steps: PageStep[];
  // For a view the PR changes, its steps before.
  before?: PageStep[];
  // The issue's criteria, from Criteria coverage, when it checked the issue.
  criteria?: Array<Pick<CriterionCoverage, "id" | "text" | "status">>;
  // From Trace paths, when it checked the issue.
  trace?: PageTrace;
}

export interface PageStep extends DynamicStep {
  // Its ends as its level draws them, or undefined where the level doesn't draw it apart.
  from?: string;
  to?: string;
}

export interface PageTrace {
  status: "passed" | "failed" | "skipped";
  reason?: string;
  // For each of the view's steps, whether Trace paths checks it: only steps between components it traces are.
  checked: boolean[];
  tests: PageTest[];
  // Indexes in the view's `steps` that no test takes.
  untested: number[];
}

export interface PageTest {
  name: string;
  file?: string;
  criterion: string;
  status: "matched" | "unmatched";
  // For each of the view's steps, whether the test took it.
  took: boolean[];
  // How far it took the view: the number of steps up to and including the last it took.
  reached: number;
  // Calls it made off the view's path, or between components the target relates nowhere.
  offPath: Array<{ source?: string; destination: string; functions: string[]; offTarget: boolean }>;
}

// A workspace's element style, as Structurizr exports it.
export interface ElementStyle {
  tag: string;
  shape?: string;
}

export interface PageInputs {
  check: CheckReport;
  // The target the PR is checked against, and the target at the fork point: the same object when the PR doesn't
  // change it.
  target: Model;
  forked: Model;
  // The files the PR changes that put it in target-change mode, and its ADRs, as `gatherReport` reads them.
  targetFiles: string[];
  adrs: Adr[];
  // The functional files the PR changes, from `codeChanges`.
  changes: FileChange[];
  // Every functional file in the repo, from `sourceFiles`.
  sourceFiles: string[];
  // The PR's workspace's element styles, from `elementStyles`.
  styles: ElementStyle[];
}

// The element styles a workspace sets, in order.
export function elementStyles(workspace: Workspace): ElementStyle[] {
  const views = workspace.views as { configuration?: { styles?: { elements?: unknown[] } } } | undefined;
  return (views?.configuration?.styles?.elements ?? []).flatMap((style): ElementStyle[] => {
    const { tag, shape } = (style ?? {}) as { tag?: unknown; shape?: unknown };
    if (typeof tag !== "string") return [];
    return [typeof shape === "string" ? { tag, shape } : { tag }];
  });
}

export function buildPageData(inputs: PageInputs): PageData {
  const { check, target: after, forked: before } = inputs;
  const diff: ModelDiff = diffModels(before, after);
  const changed = before !== after && hasChanges(diff);
  const first = changed && before.elements.size === 0;
  const elements = new Map([...before.elements, ...after.elements]);
  const relationships = new Map([...before.relationships, ...after.relationships]);
  const elementMarks = itemMarks(diff.elements);
  const relationshipMarks = itemMarks(diff.relationships);
  const viewMarks = itemMarks(diff.dynamicViews);
  const levels = levelsOf(before, after);
  const levelIds = new Set(levels.map((level) => level.id));

  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    for (let at = elements.get(id)?.parent; at !== undefined && !out.includes(at); at = elements.get(at)?.parent) {
      out.push(at);
    }
    return out;
  };

  const drift = driftOf(check, after);
  const code = codeOf(inputs, after, ancestors);
  const built = builtOf(after, inputs.sourceFiles);

  const pageElements: Record<string, PageElement> = {};
  for (const element of elements.values()) {
    const mark = elementMarks.get(element.id);
    const look = appearance(element, inputs.styles, [...relationships.values()], (id) =>
      [id, ...ancestors(id)].includes(element.id),
    );
    const page: PageElement = {
      id: element.id,
      type: element.type,
      name: element.name,
      description: element.description,
      technology: element.technology,
      ...look,
      ...(element.parent === undefined ? {} : { parent: element.parent }),
      ...(element.path === undefined ? {} : { path: element.path }),
      requirements: element.requirements,
      inBefore: before.elements.has(element.id),
      inAfter: after.elements.has(element.id),
      ...(mark === undefined || first ? {} : mark),
      ...(levelIds.has(element.id) ? { level: element.id } : {}),
      ...(built.has(element.id) ? { built: built.get(element.id)! } : {}),
    };
    const count = code.counts.get(element.id);
    if (count !== undefined) page.code = count;
    const files = code.files.get(element.id);
    if (files !== undefined) page.files = files;
    pageElements[element.id] = page;
  }
  // What sits inside each element with a level of its own.
  for (const id of levelIds) {
    const element = pageElements[id];
    if (element === undefined) continue;
    const below = [...elements.keys()].filter((each) => ancestors(each).includes(id));
    const count = (mark: Mark) => (first ? 0 : below.filter((each) => elementMarks.get(each)?.mark === mark).length);
    const inside = (each: string) => each === id || ancestors(each).includes(id);
    element.inside = {
      added: count("added"),
      removed: count("removed"),
      changed: count("changed"),
      lines: (element.code?.added ?? 0) + (element.code?.removed ?? 0),
      drifted: drift.filter((each) => inside(each.source) || inside(each.destination)).length,
    };
  }

  const pageRelationships: Record<string, PageRelationship> = {};
  for (const relationship of relationships.values()) {
    if (!elements.has(relationship.source) || !elements.has(relationship.destination)) continue;
    const mark = relationshipMarks.get(relationship.id);
    pageRelationships[relationship.id] = {
      id: relationship.id,
      source: relationship.source,
      destination: relationship.destination,
      description: relationship.description,
      technology: relationship.technology,
      inBefore: before.relationships.has(relationship.id),
      inAfter: after.relationships.has(relationship.id),
      ...(mark === undefined || first ? {} : mark),
    };
  }

  const pageLevels = levels.map((level) => pageLevel(level, before, after, diff, drift, elements, first));
  const views = pageViews(check, before, after, viewMarks, levels, first);

  return {
    changed,
    first,
    elements: pageElements,
    relationships: pageRelationships,
    levels: pageLevels,
    drift: Object.fromEntries(drift.map((each) => [each.id, each])),
    views,
    tabs: tabsOf(check, diff, changed, first, code.total, drift, views),
    target: { files: inputs.targetFiles, adrs: inputs.adrs.map(readAdr) },
    code: {
      total: code.total,
      components: [...code.files.keys()],
      outside: code.outside,
    },
    build: buildOf(check, drift),
  };
}

function hasChanges(diff: ModelDiff): boolean {
  return Object.values(diff).some(
    (changes) => changes.added.length + changes.removed.length + changes.drifted.length > 0,
  );
}

function pageLevel(
  level: Level,
  before: Model,
  after: Model,
  diff: ModelDiff,
  drift: PageDrift[],
  elements: Map<string, Element>,
  first: boolean,
): PageLevel {
  const marked = markLevel(level, before, after, diff);
  const beforeEdges = edgesAt(before, level);
  const afterEdges = edgesAt(after, level);
  const nodes = new Set([...elementsAt(before, level), ...elementsAt(after, level)]);
  const edges = [...marked.edges.entries()].map(([key, edge]): PageEdge => ({
    id: key,
    source: edge.source,
    destination: edge.destination,
    relationships: edge.relationships,
    label: edge.label,
    inBefore: beforeEdges.has(key),
    inAfter: afterEdges.has(key),
    ...(edge.mark === undefined || first ? {} : { mark: edge.mark }),
  }));
  const driftEdges = new Map<string, PageDriftEdge>();
  for (const each of drift) {
    const ends = lift(level, each);
    if (ends === undefined) continue;
    if (!level.inside(ends.source) && !level.inside(ends.destination)) {
      if (!nodes.has(ends.source) || !nodes.has(ends.destination)) continue;
    }
    const id = `drift:${pairKey(ends)}`;
    const edge = driftEdges.get(id) ?? { id, ...ends, drift: [] };
    edge.drift.push(each.id);
    driftEdges.set(id, edge);
    nodes.add(ends.source).add(ends.destination);
  }
  const scope = level.scope;
  return {
    id: level.id,
    kind: level.kind,
    title:
      scope === undefined
        ? "System context"
        : `${level.kind === "containers" ? "Containers" : "Components"} of ${scope.name}`,
    ...(scope === undefined ? {} : { scope: scope.id }),
    ...(level.parent === undefined ? {} : { parent: level.parent }),
    // In the model's order, so the layout doesn't depend on which side of the PR held an element.
    nodes: [...elements.keys()].filter((id) => nodes.has(id)),
    edges,
    drift: [...driftEdges.values()],
  };
}

// The undeclared relationships Boundaries found, through imports and through queues.
function driftOf(check: CheckReport, target: Model): PageDrift[] {
  const boundaries = check.checks.find((each) => each.check === "boundaries");
  if (boundaries === undefined || boundaries.check !== "boundaries") return [];
  const relationships = [...target.relationships.values()];
  const through = (source: string, destination: string) =>
    relationships
      .filter((first) => first.source === source)
      .filter((first) =>
        relationships.some((second) => second.source === first.destination && second.destination === destination),
      )
      .map((first) => first.destination);
  const out: PageDrift[] = boundaries.undeclared.map((each) => ({
    id: each.id,
    source: each.source,
    destination: each.destination,
    via: "imports",
    imports: each.imports,
    grants: [],
    through: through(each.source, each.destination),
  }));
  // Older reports have no queues.
  for (const each of boundaries.queues ?? []) {
    out.push({
      id: each.id,
      source: each.source,
      destination: each.destination,
      via: each.direction,
      imports: [],
      grants: each.grants.map(grantOf),
      through: through(each.source, each.destination),
    });
  }
  return out;
}

function grantOf(grant: QueueGrant): PageDrift["grants"][number] {
  return {
    node: grant.node,
    role: grant.role,
    policy: grant.policy.address,
    file: grant.policy.file,
    line: grant.policy.line,
    actions: grant.actions,
  };
}

const lines = (count: { added: number; removed: number }) => count.added + count.removed;
const byLines = (a: FileChange, b: FileChange) => lines(b) - lines(a) || (a.path < b.path ? -1 : 1);

// The PR's functional code changes per component, summed up to its container and software system, and the files no
// component's path holds.
function codeOf(inputs: PageInputs, target: Model, ancestors: (id: string) => string[]) {
  const components = componentPaths(target);
  const surplus = inputs.check.checks.find((each) => each.check === "surplus");
  // Code outside the model is what Surplus finds outside every component, when it ran.
  const outsideByCheck =
    surplus !== undefined && surplus.check === "surplus" && surplus.status !== "skipped"
      ? new Set(surplus.outside.map(normalizePath))
      : undefined;
  const files = new Map<string, FileChange[]>();
  const counts = new Map<string, CodeCount>();
  const outside: FileChange[] = [];
  const total: CodeCount = { files: 0, added: 0, removed: 0 };
  const add = (count: CodeCount, change: FileChange) => {
    count.files += 1;
    count.added += change.added;
    count.removed += change.removed;
  };
  for (const change of inputs.changes) {
    const path = normalizePath(change.path);
    const component = componentOf(path, components);
    add(total, change);
    if (component === undefined) {
      if (outsideByCheck === undefined || outsideByCheck.has(path)) outside.push(change);
      continue;
    }
    files.set(component, [...(files.get(component) ?? []), change]);
    for (const id of [component, ...ancestors(component)]) {
      const count = counts.get(id) ?? { files: 0, added: 0, removed: 0 };
      add(count, change);
      counts.set(id, count);
    }
  }
  const sorted = new Map(
    [...files.entries()]
      .map(([id, changes]) => [id, changes.sort(byLines)] as const)
      .sort(([a], [b]) => {
        const difference = lines(counts.get(b)!) - lines(counts.get(a)!);
        return difference !== 0 ? difference : a < b ? -1 : 1;
      }),
  );
  return { files: sorted, counts, outside: outside.sort(byLines), total };
}

// Whether each component with a `bearing.path` holds code yet.
function builtOf(target: Model, sourceFiles: string[]): Map<string, boolean> {
  const built = new Map<string, boolean>();
  const files = sourceFiles.map(normalizePath);
  for (const component of componentPaths(target)) {
    built.set(
      component.id,
      files.some((file) => within(file, component.path)),
    );
  }
  return built;
}

// What kind of thing an element is and the shape its box takes, in order:
// 1. the workspace's element styles, as Structurizr applies them: every style whose tag the element has, later ones
//    winning;
// 2. failing a style that names one, a container's technology;
// 3. failing that, a container that code outside it calls over HTTP, REST, JSON, gRPC or GraphQL is an API.
// A style's shape always wins; a shape that names no kind, such as a rounded box, leaves the kind to the later rules.
const builtInTags: Record<ElementType, string> = {
  person: "Person",
  softwareSystem: "Software System",
  container: "Container",
  component: "Component",
};
const technologies: Array<[RegExp, Shape]> = [
  [
    /postgres|mysql|mariadb|sql ?server|sqlite|oracle|mongo|dynamo|redis|memcache|cassandra|couch|elasticsearch|opensearch|database|\bdb\b/i,
    "Cylinder",
  ],
  [/\bsqs\b|\bsns\b|kafka|rabbit|pub ?\/? ?sub|kinesis|\bnats\b|queue|event ?bridge|service ?bus|event ?hub/i, "Pipe"],
  [/react(?! native)|\bvue\b|angular|svelte|next\.js|browser|\bspa\b/i, "WebBrowser"],
  [/\bios\b|android|swiftui|react native|flutter|mobile/i, "MobileDevice"],
  [/\bs3\b|blob storage|bucket|object stor|file stor/i, "Folder"],
];
const shapeKinds: Partial<Record<Shape, string>> = {
  Cylinder: "Database",
  Pipe: "Queue",
  WebBrowser: "Web app",
  MobileDevice: "Mobile app",
  Folder: "File store",
};
const structurizrShapes: Record<string, Shape> = {
  Box: "Box",
  RoundedBox: "RoundedBox",
  Cylinder: "Cylinder",
  Pipe: "Pipe",
  WebBrowser: "WebBrowser",
  MobileDevicePortrait: "MobileDevice",
  MobileDeviceLandscape: "MobileDevice",
  Folder: "Folder",
  Hexagon: "Hexagon",
  Person: "Person",
  Robot: "Person",
};
const overHttp = /\b(https?|rest|json|grpc|graphql)\b/i;

export function appearance(
  element: Element,
  styles: ElementStyle[],
  relationships: Relationship[],
  // Whether an element is this one or inside it.
  within: (id: string) => boolean,
): { kind: string; shape: Shape; external: boolean } {
  const tags = ["Element", builtInTags[element.type], ...element.tags];
  let styled: string | undefined;
  for (const style of styles) if (style.shape !== undefined && tags.includes(style.tag)) styled = style.shape;
  let shape: Shape | undefined = styled === undefined ? undefined : (structurizrShapes[styled] ?? "Box");
  let kind = shape === undefined ? undefined : shapeKinds[shape];
  if (kind === undefined && element.type === "container") {
    const byTechnology = technologies.find(([pattern]) => pattern.test(element.technology))?.[1];
    if (byTechnology !== undefined) {
      kind = shapeKinds[byTechnology];
      shape ??= byTechnology;
    }
  }
  if (kind === undefined && element.type === "container") {
    const called = relationships.some(
      (each) =>
        within(each.destination) && !within(each.source) && overHttp.test(`${each.technology} ${each.description}`),
    );
    if (called) kind = "API";
  }
  return {
    kind: kind ?? typeKinds[element.type],
    shape: shape ?? (element.type === "person" ? "Person" : "Box"),
    external: element.tags.includes("External"),
  };
}

// Views whose steps or title the PR changes; a refreshed criteria pin draws the same.
const redrawn = (changes: FieldChange[] | undefined) =>
  (changes ?? []).some((change) => change.field === "steps" || change.field === "description");

function pageViews(
  check: CheckReport,
  before: Model,
  after: Model,
  marks: Map<string, { mark: Mark; changes?: FieldChange[] }>,
  levels: Level[],
  first: boolean,
): PageView[] {
  const paths = check.checks.find((each) => each.check === "paths");
  const coverage = check.checks.find((each) => each.check === "coverage");
  const all = [...new Map([...before.dynamicViews, ...after.dynamicViews]).values()];
  const order = (id: string) => {
    if (first) return 2;
    const mark = marks.get(id);
    return mark?.mark === "added" ? 0 : mark?.mark === "changed" && redrawn(mark.changes) ? 1 : 2;
  };
  const sorted = all
    .map((view, index) => ({ view, index }))
    .sort((a, b) => order(a.view.id) - order(b.view.id) || a.index - b.index);
  return sorted.map(({ view }): PageView => {
    const level = levels.find((each) => each.id === view.scope) ?? levels[0]!;
    const stepsOf = (steps: DynamicStep[]) =>
      steps.map((step): PageStep => {
        const ends = lift(level, step);
        return { ...step, ...(ends === undefined ? {} : { from: ends.source, to: ends.destination }) };
      });
    const inAfter = after.dynamicViews.get(view.id);
    const inBefore = before.dynamicViews.get(view.id);
    const mark = first ? undefined : marks.get(view.id);
    const issue = /^req-(\d+)$/.exec(view.id)?.[1];
    const page: PageView = {
      id: view.id,
      ...(issue === undefined ? {} : { issue: `#${issue}` }),
      title: view.description,
      ...(view.scope === undefined ? {} : { scope: view.scope }),
      level: level.id,
      ...(mark ?? {}),
      inBefore: inBefore !== undefined,
      inAfter: inAfter !== undefined,
      steps: stepsOf((inAfter ?? view).steps),
    };
    if (inBefore !== undefined && inAfter !== undefined && redrawn(mark?.changes))
      page.before = stepsOf(inBefore.steps);
    if (
      issue !== undefined &&
      coverage !== undefined &&
      coverage.check === "coverage" &&
      coverage.status !== "skipped"
    ) {
      const criteria = coverage.criteria.filter((each) => each.id.startsWith(`#${issue}/`));
      if (criteria.length > 0) {
        page.criteria = criteria.map(({ id, text, status }) => ({ id, text, status }));
      }
    }
    const traced =
      paths !== undefined && paths.check === "paths" ? paths.views.find((each) => each.view === view.id) : undefined;
    if (traced !== undefined) {
      const expected = expectedIndexes(page.steps, traced.expected);
      const untested = new Set(traced.uncovered);
      page.trace = {
        status: traced.status,
        ...(traced.reason === undefined ? {} : { reason: traced.reason }),
        checked: expected.map((index) => index !== undefined),
        tests: traced.tests.map((test): PageTest => {
          const took = expected.map((index) => index !== undefined && (test.steps[index] ?? null) !== null);
          const off = [...new Set([...test.undeclared, ...test.offTarget])].sort((a, b) => a - b);
          return {
            name: test.name,
            ...(test.file === undefined ? {} : { file: test.file }),
            criterion: test.criterion,
            status: test.status,
            took,
            reached: took.lastIndexOf(true) + 1,
            offPath: off.flatMap((index) => {
              const call = test.observed[index];
              if (call === undefined) return [];
              return [
                {
                  ...(call.source === undefined ? {} : { source: call.source }),
                  destination: call.destination,
                  functions: call.functions,
                  offTarget: test.offTarget.includes(index),
                },
              ];
            }),
          };
        }),
        untested: expected.flatMap((index, step) => (index !== undefined && untested.has(index) ? [step] : [])),
      };
    }
    return page;
  });
}

// For each of a view's steps, the index of the step Trace paths checks it as. Trace paths keeps only the steps
// between components it traces, and joins consecutive ones between the same two into one, so this walks both in
// order: a step is the current checked step or the next, matched by its ends.
function expectedIndexes(steps: DynamicStep[], expected: Array<{ source: string; destination: string }>) {
  let at = -1;
  const same = (step: DynamicStep, index: number) =>
    expected[index]?.source === step.source && expected[index]?.destination === step.destination;
  return steps.map((step): number | undefined => {
    if (at >= 0 && same(step, at)) return at;
    if (same(step, at + 1)) return ++at;
    return undefined;
  });
}

// An ADR's title and the sections a reviewer reads first, from the template `bearing init` writes.
function readAdr(adr: Adr): PageAdr {
  const section = (heading: RegExp) => {
    const match = new RegExp(`^##\\s+${heading.source}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im").exec(adr.text);
    return match?.[1]?.trim() ?? "";
  };
  return {
    path: adr.path,
    title: /^#\s+(.+)$/m.exec(adr.text)?.[1]?.trim() ?? adr.path,
    reason: section(/Context/),
    decision: section(/Decision/),
    alternatives: section(/Alternatives(?: considered)?/),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Each tab's result, from the checks it holds: Target valid and Target change in Target, Surplus in Code, Claim,
// Boundaries and Deployment in Build, Criteria coverage and Trace paths in Behaviour.
const tabChecks: Record<TabId, CheckId[]> = {
  target: ["valid", "target"],
  code: ["surplus"],
  build: ["claim", "boundaries", "deployment"],
  behaviour: ["coverage", "paths"],
};

function tabsOf(
  check: CheckReport,
  diff: ModelDiff,
  changed: boolean,
  first: boolean,
  code: CodeCount,
  drift: PageDrift[],
  views: PageView[],
): Record<TabId, PageTab> {
  const checks = (tab: TabId) =>
    tabChecks[tab].flatMap((id) => {
      const found = check.checks.find((each) => each.check === id);
      if (found === undefined) return [];
      return [
        {
          check: found.check,
          title: checkTitles[found.check],
          status: found.status,
          blocking: found.blocking,
          summary: summarise(found),
        } satisfies PageCheck,
      ];
    });
  const tab = (id: TabId, counter: string): PageTab => {
    const held = checks(id);
    return {
      counter,
      attention: held.some((each) => each.status === "failed" || each.status === "flagged"),
      checks: held,
    };
  };

  // Target: the model changes, as "+3 −1 ~2" over elements and relationships.
  const elementMarks = itemMarks(diff.elements);
  const relationshipMarks = itemMarks(diff.relationships);
  const marks = [...elementMarks.values(), ...relationshipMarks.values()];
  const count = (mark: Mark) => marks.filter((each) => each.mark === mark).length;
  const signed = [
    count("added") > 0 ? `+${count("added")}` : "",
    count("removed") > 0 ? `−${count("removed")}` : "",
    count("changed") > 0 ? `~${count("changed")}` : "",
  ].filter((part) => part !== "");
  const targetCounter = !changed
    ? "no change"
    : first
      ? "first design"
      : signed.length > 0
        ? signed.join(" ")
        : "views only";

  const codeCounter = code.files === 0 ? "no change" : `+${code.added} −${code.removed}`;

  const claim = check.checks.find((each) => each.check === "claim");
  const deployment = check.checks.find((each) => each.check === "deployment");
  const mismatches = claim !== undefined && claim.check === "claim" ? claim.mismatches.length : 0;
  const nodes =
    deployment !== undefined && deployment.check === "deployment"
      ? deployment.added.length + deployment.removed.length + deployment.drifted.length
      : 0;
  const buildCounter =
    drift.length > 0
      ? `${drift.length} undeclared`
      : mismatches > 0
        ? plural(mismatches, "claim mismatch", "claim mismatches")
        : nodes > 0
          ? `${plural(nodes, "node")} ${nodes === 1 ? "differs" : "differ"}`
          : "matches";

  const traced = views.flatMap((view) => (view.trace === undefined ? [] : [view.trace]));
  const offPath = traced.reduce(
    (sum, trace) => sum + trace.tests.filter((test) => test.status === "unmatched").length,
    0,
  );
  const untested = traced.reduce((sum, trace) => sum + trace.untested.length, 0);
  const coverage = check.checks.find((each) => each.check === "coverage");
  const uncovered =
    coverage !== undefined && coverage.check === "coverage"
      ? coverage.criteria.filter((each) => each.status !== "covered").length
      : 0;
  const behaviourCounter =
    offPath > 0
      ? `${offPath} off path`
      : untested > 0
        ? `${untested} untested`
        : uncovered > 0
          ? plural(uncovered, "criterion", "criteria") + " uncovered"
          : traced.length > 0 || (coverage?.status ?? "skipped") !== "skipped"
            ? "covered"
            : "not checked";

  return {
    target: tab("target", targetCounter),
    code: tab("code", codeCounter),
    build: tab("build", buildCounter),
    behaviour: tab("behaviour", behaviourCounter),
  };
}

function buildOf(check: CheckReport, drift: PageDrift[]): BuildFindings {
  const claim = check.checks.find((each) => each.check === "claim");
  const deployment = check.checks.find((each) => each.check === "deployment");
  return {
    drift: drift.map((each) => each.id),
    claim:
      claim !== undefined && claim.check === "claim"
        ? {
            status: claim.status,
            ...(claim.file === undefined ? {} : { file: claim.file }),
            mismatches: claim.mismatches,
          }
        : { status: "skipped", mismatches: [] },
    deployment:
      deployment === undefined
        ? { status: "skipped", summary: "" }
        : { status: deployment.status, summary: summarise(deployment) },
  };
}
