#!/usr/bin/env node
// Writes the architecture page for a PR: one self-contained HTML file, from the inputs `bearing report` reads.
//
//   node build.mjs [--repo <dir>] [--base <ref>] [--check <check.json>] [--out <page.html>]
//
// Imports Bearing from ../../dist, so run `npm run build` at the repo root first.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import ELK from "elkjs/lib/elk.bundled.js";
import { runChecks } from "../../dist/check.js";
import { loadConfig } from "../../dist/config.js";
import { diffModels } from "../../dist/diff.js";
import { buildOverlay, gatherReport } from "../../dist/report.js";

const here = import.meta.dirname;
const nodeWidth = 190;
const nodeHeight = 76;
const textWidth = (text) => Math.min(220, 6.4 * text.length + 8);

const { values: args } = parseArgs({
  options: {
    repo: { type: "string", default: "." },
    base: { type: "string" },
    check: { type: "string" },
    out: { type: "string", default: "architecture.html" },
  },
});

const config = loadConfig(resolve(args.repo));
const check =
  args.check === undefined
    ? await runChecks(config, args.base === undefined ? {} : { base: args.base })
    : JSON.parse(await readFile(args.check, "utf8"));
const { target: after, forked: before } = await gatherReport(config, args.base);

const data = await pageData(before, after, check);
const template = await readFile(join(here, "template.html"), "utf8");
// JSON in a script element ends at the first "</script", so every "<" goes in escaped.
const json = JSON.stringify(data).replaceAll("<", "\\u003c");
// Prettier may space the placeholder out, so any whitespace between its parts matches.
const placeholder = /\/\*DATA\*\/\s*null/;
if (!placeholder.test(template)) throw new Error("template.html has no /*DATA*/ null placeholder");
const page = template.replace(placeholder, () => json);
await mkdir(dirname(resolve(args.out)), { recursive: true });
await writeFile(args.out, page);
process.stderr.write(`Wrote ${args.out} (${(page.length / 1024).toFixed(0)} KB)\n`);

// ---------------------------------------------------------------------------------------------------------------

async function pageData(before, after, check) {
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

  for (const level of levels) level.layout = await layout(level, elements);

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
async function layout(level, elements) {
  const elk = new ELK();
  const edgeOf = (edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.destination],
    labels: edge.label === "" ? [] : [{ text: edge.label, width: textWidth(edge.label), height: 14 }],
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
  const routes = {};
  for (const edge of edges) {
    const section = edge.sections?.[0];
    if (section === undefined) continue;
    const { x: dx, y: dy } = origins[edge.container ?? "root"] ?? origins.root;
    const label = edge.labels?.[0];
    routes[edge.id] = {
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(({ x, y }) => [x + dx, y + dy]),
      label: label === undefined ? undefined : { x: label.x + dx, y: label.y + dy, width: label.width },
    };
  }
  return { width: laid.width, height: laid.height, shapes, routes };
}
