// The page's data: the PR's levels, laid out, with what it changes and where the code drifts. Shared by build.mjs and
// bench.mjs.

import ELK from "elkjs/lib/elk.bundled.js";
import { diffModels } from "../../dist/diff.js";
import { buildOverlay } from "../../dist/report.js";

const nodeWidth = 190;
const nodeHeight = 76;
const textWidth = (text) => Math.min(220, 6.4 * text.length + 8);

export async function pageData(before, after, check, options = {}) {
  const changed = before !== after;
  const diff = changed ? diffModels(before, after) : undefined;
  const elements = new Map([...before.elements, ...after.elements]);
  const relationships = new Map([...before.relationships, ...after.relationships]);

  // What the PR does to each element and relationship of the target. A change to the requirements alone isn't one.
  const marks = (changes) => {
    const out = new Map();
    if (changes === undefined) return out;
    for (const each of changes.added) out.set(each.id, { mark: "added" });
    for (const each of changes.removed) out.set(each.id, { mark: "removed" });
    for (const drift of changes.drifted) {
      const real = drift.changes.filter((change) => change.field !== "requirements");
      if (real.length > 0) out.set(drift.id, { mark: "changed", changes: real });
    }
    return out;
  };
  const elementMarks = marks(diff?.elements);
  const relationshipMarks = marks(diff?.relationships);
  const viewMarks = marks(diff?.dynamicViews);

  // Where the code drifts from the target, from the checks, as `bearing report` draws it.
  const drift = buildOverlay({ check, target: after, forked: before }).edges.filter((edge) => edge.mark === "drifted");

  const chain = (id) => {
    const out = [];
    for (let at = elements.get(id); at !== undefined; at = elements.get(at.parent)) out.unshift(at.id);
    return out;
  };
  const childrenOf = (id) => [...elements.values()].filter((each) => each.parent === id);

  // One level per C4 diagram: the system context, then each software system's containers and each container's
  // components. `scope` is the element the level opens; undefined for the context.
  const scopes = [
    undefined,
    ...[...elements.values()].filter(
      (each) => (each.type === "softwareSystem" || each.type === "container") && childrenOf(each.id).length > 0,
    ),
  ];
  const levels = [];
  for (const scope of scopes) {
    const scopeChain = scope === undefined ? [] : chain(scope.id);
    // The element that stands for `id` at this level: inside the scope, its ancestor just below the scope; outside
    // it, its ancestor where its chain leaves the scope's. Nothing for the scope itself or what holds it.
    const at = (id) => {
      const ids = chain(id);
      if (ids.length === 0) return undefined;
      if (scope !== undefined && ids.includes(scope.id)) return ids[ids.indexOf(scope.id) + 1];
      const split = ids.findIndex((each, index) => each !== scopeChain[index]);
      return split === -1 ? undefined : ids[split];
    };
    const inside = new Set(scope === undefined ? [] : childrenOf(scope.id).map((each) => each.id));

    // Relationships lifted to the level, one edge per pair, with what the PR does to each.
    const edges = new Map();
    for (const relationship of relationships.values()) {
      const source = at(relationship.source);
      const destination = at(relationship.destination);
      if (source === undefined || destination === undefined || source === destination) continue;
      if (scope !== undefined && !inside.has(source) && !inside.has(destination)) continue;
      const key = `${source}->${destination}`;
      const edge = edges.get(key) ?? { id: `e${edges.size}`, source, destination, relationships: [] };
      edge.relationships.push(relationship.id);
      edges.set(key, edge);
    }
    for (const edge of edges.values()) {
      const each = edge.relationships.map((id) => relationshipMarks.get(id)?.mark);
      edge.mark = each.every((mark) => mark === "added")
        ? "added"
        : each.every((mark) => mark === "removed")
          ? "removed"
          : each.some((mark) => mark !== undefined)
            ? "changed"
            : undefined;
      const relationship = relationships.get(edge.relationships[0]);
      edge.label =
        edge.relationships.length === 1 ? relationship.description : `${edge.relationships.length} relationships`;
      edge.inBefore = edge.relationships.some((id) => before.relationships.has(id));
      edge.inAfter = edge.relationships.some((id) => after.relationships.has(id));
    }
    const driftEdges = [];
    for (const each of drift) {
      const source = at(each.source);
      const destination = at(each.destination);
      if (source === undefined || destination === undefined || source === destination) continue;
      if (scope !== undefined && !inside.has(source) && !inside.has(destination)) continue;
      driftEdges.push({ id: `d${driftEdges.length}`, source, destination, label: each.label });
    }

    // Everything inside the scope, and what outside it connects to them.
    const nodes = new Set(inside);
    if (scope === undefined) for (const each of elements.values()) if (each.parent === undefined) nodes.add(each.id);
    for (const edge of [...edges.values(), ...driftEdges]) nodes.add(edge.source).add(edge.destination);

    levels.push({
      id: scope?.id ?? "context",
      title:
        scope === undefined
          ? "System context"
          : `${scope.type === "softwareSystem" ? "Containers" : "Components"} of ${scope.name}`,
      scope: scope?.id,
      parentLevel: scope === undefined ? undefined : (scope.parent ?? "context"),
      nodes: [...nodes],
      edges: [...edges.values()],
      drift: driftEdges,
    });
  }

  for (const level of levels) level.layout = await layout(level, elements, options.layout);

  // How many changes and drifted relationships sit inside each element, to point the reader at what to open.
  const inside = (id) => [...elements.values()].filter((each) => chain(each.id).includes(id) && each.id !== id);
  const counts = {};
  for (const each of elements.values()) {
    const below = inside(each.id).map((child) => child.id);
    const changes = below.filter((id) => elementMarks.has(id)).length;
    const drifts = drift.filter((edge) => below.includes(edge.source) || below.includes(edge.destination)).length;
    if (changes + drifts > 0) counts[each.id] = { changes, drifts };
  }

  const paths = check.checks.find((each) => each.check === "paths");
  const views = [...new Map([...before.dynamicViews, ...after.dynamicViews]).values()].map((view) => {
    const traced = paths?.views?.find((each) => each.view === view.id);
    return {
      id: view.id,
      title: view.description,
      scope: view.scope,
      steps: view.steps,
      before: before.dynamicViews.get(view.id)?.steps,
      mark: viewMarks.get(view.id)?.mark,
      trace:
        traced === undefined
          ? undefined
          : { status: traced.status, reason: traced.reason, uncovered: traced.uncovered, tests: traced.tests.length },
    };
  });

  return {
    changed,
    checks: check.checks.map((each) => ({ check: each.check, status: each.status, blocking: each.blocking })),
    elements: Object.fromEntries(
      [...elements.values()].map((each) => [
        each.id,
        {
          name: each.name,
          type: each.type,
          technology: each.technology,
          description: each.description,
          parent: each.parent,
          path: each.path,
          requirements: each.requirements,
          ...appearance(each, options.styles ?? [], relationships, (id) => chain(id).includes(each.id)),
          inBefore: before.elements.has(each.id),
          inAfter: after.elements.has(each.id),
          ...elementMarks.get(each.id),
        },
      ]),
    ),
    relationships: Object.fromEntries(
      [...relationships.values()].map((each) => [
        each.id,
        {
          source: each.source,
          destination: each.destination,
          description: each.description,
          technology: each.technology,
          ...relationshipMarks.get(each.id),
        },
      ]),
    ),
    counts,
    levels,
    views,
  };
}

// Lays a level out once, with every element and edge it can show in any mode, so nothing moves when the reader
// switches between before, after, change and drift.
//
// Splines, with Brandes–Köpf node placement and labels placed after routing, take about one curve per edge and no
// corners; see the README for how the options compare. `options.labels` is "after" to place edge labels once the edges are routed, so ELK doesn't route around them, or
// "layout" to have ELK place them. `options.elk` overrides ELK's options.
export const defaultLayout = {
  labels: "after",
  elk: {
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
    "elk.edgeRouting": "SPLINES",
  },
};

async function layout(level, elements, options = defaultLayout) {
  const elk = new ELK();
  const labelsInLayout = options.labels === "layout";
  const edgeOf = (edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.destination],
    labels:
      edge.label === "" || !labelsInLayout ? [] : [{ text: edge.label, width: textWidth(edge.label), height: 14 }],
  });
  const box = (id) => ({ id, width: nodeWidth, height: nodeHeight });
  const outside = level.nodes.filter((id) => elements.get(id)?.parent !== level.scope || level.scope === undefined);
  const insideIds =
    level.scope === undefined ? [] : level.nodes.filter((id) => elements.get(id)?.parent === level.scope);
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "50",
      "elk.spacing.nodeNode": "30",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.placement": "CENTER",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      ...options.elk,
    },
    children: [
      ...(level.scope === undefined
        ? []
        : [
            {
              id: `boundary:${level.scope}`,
              layoutOptions: { "elk.padding": "[top=36,left=24,bottom=24,right=24]" },
              children: insideIds.map(box),
            },
          ]),
      ...outside.filter((id) => !insideIds.includes(id)).map(box),
    ],
    edges: [...level.edges, ...level.drift].map(edgeOf),
  };
  const laid = await elk.layout(graph);
  // ELK gives each shape relative to its parent, and each edge relative to its container, so both are moved to the
  // page's frame.
  const shapes = {};
  const origins = { root: { x: 0, y: 0 } };
  const edges = [];
  const walk = (node, dx, dy) => {
    edges.push(...(node.edges ?? []));
    for (const child of node.children ?? []) {
      const x = dx + child.x;
      const y = dy + child.y;
      shapes[child.id] = { x, y, width: child.width, height: child.height };
      origins[child.id] = { x, y };
      walk(child, x, y);
    }
  };
  walk(laid, 0, 0);
  const spline = graph.layoutOptions["elk.edgeRouting"] === "SPLINES";
  const texts = new Map([...level.edges, ...level.drift].map((edge) => [edge.id, edge.label]));
  const routes = {};
  for (const edge of edges) {
    const points = sectionPoints(edge.sections ?? []);
    if (points.length === 0) continue;
    const { x: dx, y: dy } = origins[edge.container ?? "root"] ?? origins.root;
    routes[edge.id] = {
      points: points.map(([x, y]) => [x + dx, y + dy]),
      // For splines, the points after the first are cubic Bézier curves, three to a curve: two control points, then
      // where it ends.
      ...(spline ? { curve: true } : {}),
    };
    const label = edge.labels?.[0];
    if (label !== undefined) routes[edge.id].label = { x: label.x + dx, y: label.y + dy, width: label.width };
  }

  // Labels ELK didn't place go where they overlap no box and no other label, longest edges first.
  const boxes = Object.entries(shapes)
    .filter(([id]) => !id.startsWith("boundary:"))
    .map(([, box]) => box);
  const placed = [];
  const order = Object.entries(routes)
    .filter(([id, route]) => route.label === undefined && (texts.get(id) ?? "") !== "")
    .sort(([, a], [, b]) => length(b.points) - length(a.points));
  for (const [id, route] of order) {
    const label = placeLabel(route.points, textWidth(texts.get(id)), [...boxes, ...placed], laid);
    route.label = label;
    placed.push({ x: label.x, y: label.y, width: label.width, height: 14 });
  }
  return { width: laid.width, height: laid.height, shapes, routes };
}

// An edge's points in order. ELK splits an edge that crosses a boundary into sections, each starting where the last
// ended.
function sectionPoints(sections) {
  const byId = new Map(sections.map((section) => [section.id, section]));
  let section = sections.find((each) => (each.incomingSections ?? []).length === 0) ?? sections[0];
  const points = [];
  const seen = new Set();
  while (section !== undefined && !seen.has(section.id)) {
    seen.add(section.id);
    const own = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(({ x, y }) => [x, y]);
    points.push(...(points.length === 0 ? own : own.slice(1)));
    section = byId.get(section.outgoingSections?.[0]);
  }
  return points;
}

const length = (points) =>
  points.slice(1).reduce((sum, [x, y], i) => sum + Math.hypot(x - points[i][0], y - points[i][1]), 0);

// Where a label goes: along the edge's longer runs, beside a vertical run and above or below any other, at the first
// spot clear of `obstacles`; failing that, the middle of the longest run.
function placeLabel(points, width, obstacles, bounds) {
  const height = 14;
  const runs = points
    .slice(1)
    .map((end, i) => ({ start: points[i], end, length: Math.hypot(end[0] - points[i][0], end[1] - points[i][1]) }))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const candidates = [];
  for (const run of runs) {
    const vertical = Math.abs(run.end[0] - run.start[0]) < Math.abs(run.end[1] - run.start[1]);
    for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const cx = run.start[0] + t * (run.end[0] - run.start[0]);
      const cy = run.start[1] + t * (run.end[1] - run.start[1]);
      if (vertical) {
        candidates.push({ x: cx + 6, y: cy - height / 2 }, { x: cx - 6 - width, y: cy - height / 2 });
      } else {
        candidates.push({ x: cx - width / 2, y: cy - height - 4 }, { x: cx - width / 2, y: cy + 4 });
      }
    }
  }
  const clear = (spot) =>
    spot.x >= 0 &&
    spot.y >= 0 &&
    spot.x + width <= bounds.width &&
    spot.y + height <= bounds.height &&
    obstacles.every(
      (box) =>
        spot.x + width + 2 < box.x ||
        box.x + box.width + 2 < spot.x ||
        spot.y + height + 2 < box.y ||
        box.y + (box.height ?? height) + 2 < spot.y,
    );
  const spot = candidates.find(clear) ?? candidates[0];
  return {
    x: Math.min(Math.max(spot.x, 0), bounds.width - width),
    y: Math.min(Math.max(spot.y, 0), bounds.height - height),
    width,
  };
}

// What kind of thing an element is, and the shape to draw it as. The workspace's own element styles come first, as
// Structurizr applies them: every style whose tag the element has, later ones winning. Failing a shape there, a
// container's technology says, and failing that, a container that code outside it calls over HTTP is an API.
const builtInTags = {
  person: "Person",
  softwareSystem: "Software System",
  container: "Container",
  component: "Component",
};
const technologies = [
  [
    /postgres|mysql|mariadb|sql ?server|sqlite|oracle|mongo|dynamo|redis|cassandra|elasticsearch|database|\bdb\b/i,
    "Cylinder",
  ],
  [/\bsqs\b|\bsns\b|kafka|rabbit|pub ?\/? ?sub|kinesis|\bnats\b|queue|event ?bridge|service ?bus/i, "Pipe"],
  [/react|vue|angular|svelte|next\.js|browser|\bspa\b/i, "WebBrowser"],
  [/\bios\b|android|swiftui|react native|flutter|mobile/i, "MobileDevicePortrait"],
  [/\bs3\b|blob storage|bucket|object stor/i, "Folder"],
];
const kinds = {
  Cylinder: "Database",
  Pipe: "Queue",
  WebBrowser: "Web app",
  MobileDevicePortrait: "Mobile app",
  MobileDeviceLandscape: "Mobile app",
  Folder: "File store",
};
const overHttp = /\b(https?|rest|json|grpc|graphql|api)\b/i;

function appearance(element, styles, relationships, within) {
  const tags = ["Element", builtInTags[element.type], ...element.tags];
  let shape;
  for (const style of styles) if (style.shape !== undefined && tags.includes(style.tag)) shape = style.shape;
  if (shape === undefined && element.type === "container") {
    shape = technologies.find(([pattern]) => pattern.test(element.technology))?.[1];
  }
  let kind = kinds[shape];
  if (kind === undefined && element.type === "container") {
    const called = [...relationships.values()].some(
      (each) =>
        within(each.destination) && !within(each.source) && overHttp.test(`${each.technology} ${each.description}`),
    );
    if (called) kind = "API";
  }
  return {
    ...(shape === undefined ? {} : { shape }),
    ...(kind === undefined ? {} : { kind }),
    ...(element.tags.includes("External") ? { external: true } : {}),
  };
}
