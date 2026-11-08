import type { ELK, ElkEdgeSection, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { PageData, PageLevel } from "./page-data.js";

// Lays out each level of the architecture page with ELK, when the page is built, so the page itself needs no layout
// library. Each level is laid out once over every element and edge any mode can show, so nothing moves when the
// reader switches between Change, Before, After and Drift. See #116 and #119.
//
// Layered, top to bottom, with the level's scope as a compound node holding its children; Brandes–Köpf balanced node
// placement and spline routing. Edge labels are placed after routing rather than by ELK, which turns the labels it
// places into dummy nodes that edges route around. The spike's bench (`spikes/architecture-page/bench.mjs`) measured
// this at about one curve per edge.
//
// The same levels give the same layouts: ELK's layered algorithm is deterministic for a given graph, and every list
// here follows the level's order.

export type Point = [number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LevelLayout {
  width: number;
  height: number;
  // Each node's box, by element ID.
  shapes: Record<string, Rect>;
  // The scope's boundary, for every level but the system context.
  boundary?: Rect;
  // Each edge's route, by edge ID: the level's edges and its drift edges.
  routes: Record<string, Route>;
}

export interface Route {
  // Where the edge starts, its spline control points and where it ends, with the sections of an edge that crosses a
  // boundary joined in order.
  points: Point[];
  // The SVG path to draw.
  d: string;
  // Where its label goes; absent for an edge with no label.
  label?: Rect;
}

// Boxes are 190 × 76, as the style guide (#117) sets them.
export const nodeWidth = 190;
export const nodeHeight = 76;
export const labelHeight = 14;
// What a drift edge is labelled.
export const driftLabel = "undeclared";
// An edge label's width, estimated for 11px type, up to the widest a label is drawn.
export const labelWidth = (text: string) => Math.min(220, Math.round(6.4 * text.length + 8));
// The boundary's padding leaves room for its name, top left.
const padding = { top: 36, left: 24, bottom: 24, right: 24 };

const layoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "50",
  "elk.spacing.nodeNode": "30",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  "elk.edgeRouting": "SPLINES",
  // Follow the level's order where it costs no crossings, so a small change to the model moves little.
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};

// Every level's layout, by level ID. elkjs is loaded only here, so nothing but building a page pays for it.
export async function layOutLevels(data: Pick<PageData, "elements" | "levels">): Promise<Record<string, LevelLayout>> {
  // elk.bundled.js is CommonJS, so its default export is the constructor itself, though its typings don't say so.
  const { default: Elk } = (await import("elkjs/lib/elk.bundled.js")) as unknown as { default: new () => ELK };
  const elk = new Elk();
  const out: Record<string, LevelLayout> = {};
  for (const level of data.levels) {
    out[level.id] = await layOutLevel(level, data.elements, (graph) => elk.layout(graph));
  }
  return out;
}

export async function layOutLevel(
  level: PageLevel,
  elements: PageData["elements"],
  layout: (graph: ElkNode) => Promise<ElkNode>,
): Promise<LevelLayout> {
  // ELK gets IDs of its own, so no element or edge ID can clash with another or with the boundary's.
  const nodeIds = new Map(level.nodes.map((id, index) => [id, `n${index}`]));
  const box = (id: string): ElkNode => ({ id: nodeIds.get(id)!, width: nodeWidth, height: nodeHeight });
  const scope = level.scope;
  const inside = scope === undefined ? [] : level.nodes.filter((id) => elements[id]?.parent === scope);
  const outside = level.nodes.filter((id) => !inside.includes(id));

  const edges = [
    ...level.edges.map((edge) => ({ ...edge, text: edge.label })),
    ...level.drift.map((edge) => ({ ...edge, text: driftLabel })),
  ].filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.destination));
  const edgeIds = new Map(edges.map((edge, index) => [`e${index}`, edge]));

  const graph: ElkNode = {
    id: "root",
    layoutOptions,
    children: [
      ...(scope === undefined
        ? []
        : [
            {
              id: "boundary",
              layoutOptions: {
                "elk.padding": `[top=${padding.top},left=${padding.left},bottom=${padding.bottom},right=${padding.right}]`,
              },
              children: inside.map(box),
            },
          ]),
      ...outside.map(box),
    ],
    edges: [...edgeIds].map(([id, edge]) => ({
      id,
      sources: [nodeIds.get(edge.source)!],
      targets: [nodeIds.get(edge.destination)!],
    })),
  };
  const laid = await layout(graph);
  const { shapes, origins, laidEdges } = toPageFrame(laid);

  const elementOf = new Map([...nodeIds].map(([id, elk]) => [elk, id]));
  const result: LevelLayout = {
    width: round(laid.width ?? 0),
    height: round(laid.height ?? 0),
    shapes: {},
    routes: {},
  };
  for (const [elkId, rect] of shapes) {
    if (elkId === "boundary") result.boundary = rect;
    else if (elementOf.has(elkId)) result.shapes[elementOf.get(elkId)!] = rect;
  }

  for (const [elkId, edge] of edgeIds) {
    const laidEdge = laidEdges.get(elkId);
    if (laidEdge === undefined) continue;
    const origin = origins.get(laidEdge.container ?? "root") ?? [0, 0];
    const sections = orderSections(laidEdge.sections ?? []).map((section) =>
      straighten(sectionPoints(section).map(([x, y]): Point => [round(x + origin[0]), round(y + origin[1])])),
    );
    if (sections.length === 0) continue;
    result.routes[edge.id] = { points: joinSections(sections), d: pathOf(sections) };
  }

  // Labels go clear of every box, of the boundary's name and of every label already placed, longest edges first.
  const obstacles: Rect[] = Object.values(result.shapes);
  if (result.boundary !== undefined && scope !== undefined) {
    const name = elements[scope]?.name ?? "";
    obstacles.push({ ...result.boundary, width: Math.min(result.boundary.width, labelWidth(name) + 24), height: 28 });
  }
  const order = [...edgeIds.values()]
    .filter((edge) => edge.text !== "" && result.routes[edge.id] !== undefined)
    .map((edge) => ({ edge, route: result.routes[edge.id]! }))
    .sort((a, b) => length(b.route.points) - length(a.route.points));
  for (const { edge, route } of order) {
    route.label = placeLabel(route.points, labelWidth(edge.text), obstacles, result);
    obstacles.push(route.label);
  }
  return result;
}

// elkjs's typings leave out the container it gives each edge: the node its points are relative to.
export type LaidEdge = ElkExtendedEdge & { container?: string };

// elkjs 0.9.3 ignores `elk.json.shapeCoords` and `elk.json.edgeCoords`: each shape comes back relative to its parent,
// and each edge relative to its `container`. This moves the shapes to the page's frame, and gives each container's
// origin in it for the edges.
export function toPageFrame(laid: ElkNode): {
  shapes: Map<string, Rect>;
  origins: Map<string, Point>;
  laidEdges: Map<string, LaidEdge>;
} {
  const shapes = new Map<string, Rect>();
  const origins = new Map<string, Point>([[laid.id, [0, 0]]]);
  const laidEdges = new Map<string, LaidEdge>();
  const walk = (node: ElkNode, dx: number, dy: number) => {
    for (const edge of (node.edges ?? []) as LaidEdge[]) laidEdges.set(edge.id, edge);
    for (const child of node.children ?? []) {
      const x = dx + (child.x ?? 0);
      const y = dy + (child.y ?? 0);
      shapes.set(child.id, {
        x: round(x),
        y: round(y),
        width: round(child.width ?? 0),
        height: round(child.height ?? 0),
      });
      origins.set(child.id, [x, y]);
      walk(child, x, y);
    }
  };
  walk(laid, 0, 0);
  return { shapes, origins, laidEdges };
}

// An edge that crosses a boundary can come back in several sections, each starting where the last ended: this puts
// them in order, from the one nothing leads into, following each one's outgoing section.
export function orderSections(sections: ElkEdgeSection[]): ElkEdgeSection[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const out: ElkEdgeSection[] = [];
  let section = sections.find((each) => (each.incomingSections ?? []).length === 0) ?? sections[0];
  while (section !== undefined && !out.includes(section)) {
    out.push(section);
    section = byId.get(section.outgoingSections?.[0] ?? "");
  }
  return out;
}

const sectionPoints = (section: ElkEdgeSection): Point[] =>
  [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(({ x, y }): Point => [x, y]);

// A section's points with each run of straight cubic pieces along one line merged into one piece. ELK often gives a
// long straight run as several pieces with every control point on the line: drawn as one, it looks the same and the
// page carries less.
export function straighten(points: Point[]): Point[] {
  if (points.length === 0) return points;
  const out: Point[] = [points[0]!];
  // Whether the last piece in `out` is straight.
  let straight = false;
  let i = 1;
  for (; i + 2 < points.length; i += 3) {
    const start = out[out.length - 1]!;
    const [c1, c2, end] = [points[i]!, points[i + 1]!, points[i + 2]!];
    const isStraight = onLine(start, end, c1) && onLine(start, end, c2);
    if (isStraight && straight) {
      const from = out[out.length - 4]!;
      if (onLine(from, end, start)) {
        out.splice(out.length - 3, 3, ...thirds(from, end));
        continue;
      }
    }
    out.push(c1, c2, end);
    straight = isStraight;
  }
  out.push(...points.slice(i));
  return out;
}

// Whether `point` lies within half a pixel of the line through `a` and `b`, between them.
function onLine(a: Point, b: Point, point: Point): boolean {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]) <= 0.5;
  const along = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length;
  const across = Math.abs((point[0] - a[0]) * dy - (point[1] - a[1]) * dx) / length;
  return across <= 0.5 && along >= -0.5 && along <= length + 0.5;
}

// A straight cubic piece's control points and end: a third and two thirds of the way along, then the end.
const thirds = (from: Point, to: Point): Point[] => [
  [round(from[0] + (to[0] - from[0]) / 3), round(from[1] + (to[1] - from[1]) / 3)],
  [round(from[0] + (2 * (to[0] - from[0])) / 3), round(from[1] + (2 * (to[1] - from[1])) / 3)],
  to,
];

// The sections' points as one run: each section after the first starts where the last ended.
export function joinSections(sections: Point[][]): Point[] {
  return sections.flatMap((points, index) => (index === 0 ? points : points.slice(1)));
}

// A spline's SVG path. After its start, each section's points are cubic Bézier curves of three: two control points,
// then where the curve ends. ELK's control points don't always come in threes, so what's left of a section is a
// quadratic curve or a straight run. Each section is drawn on its own, so one with a remainder doesn't throw the next
// out of step.
export function pathOf(sections: Point[][]): string {
  const at = ([x, y]: Point) => `${x},${y}`;
  const parts: string[] = [];
  for (const [index, points] of sections.entries()) {
    if (points.length === 0) continue;
    if (index === 0) parts.push(`M${at(points[0]!)}`);
    let i = 1;
    for (; i + 2 < points.length; i += 3) parts.push(`C${at(points[i]!)} ${at(points[i + 1]!)} ${at(points[i + 2]!)}`);
    if (points.length - i === 2) parts.push(`Q${at(points[i]!)} ${at(points[i + 1]!)}`);
    if (points.length - i === 1) parts.push(`L${at(points[i]!)}`);
  }
  return parts.join(" ");
}

// The point `distance` along a run of points, and the direction of the run it's on.
function along(points: Point[], distance: number): { at: Point; direction: Point } {
  let left = distance;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (run === 0) continue;
    if (left <= run || i === points.length - 1) {
      const t = Math.min(left / run, 1);
      return { at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], direction: [b[0] - a[0], b[1] - a[1]] };
    }
    left -= run;
  }
  return { at: points[0] ?? [0, 0], direction: [0, 1] };
}

const length = (points: Point[]) =>
  points.slice(1).reduce((sum, [x, y], i) => sum + Math.hypot(x - points[i]![0], y - points[i]![1]), 0);

// Where a label goes: at the first spot inside the diagram clear of every obstacle, trying spots along the edge from
// its middle outwards. At each, beside the edge first (to the side where it runs up or down, above or below where it
// runs across), then further out, then over the edge itself, which the page draws the label's background over.
// Failing a clear spot, the one that overlaps the obstacles least.
export function placeLabel(
  points: Point[],
  width: number,
  obstacles: Rect[],
  bounds: { width: number; height: number },
): Rect {
  const height = labelHeight;
  const total = length(points);
  const candidates: Array<{ x: number; y: number }> = [];
  for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
    const {
      at: [cx, cy],
      direction: [dx, dy],
    } = along(points, t * total);
    const vertical = Math.abs(dx) < Math.abs(dy);
    for (const gap of [6, 20]) {
      if (vertical) candidates.push({ x: cx + gap, y: cy - height / 2 }, { x: cx - gap - width, y: cy - height / 2 });
      else candidates.push({ x: cx - width / 2, y: cy - height - gap + 2 }, { x: cx - width / 2, y: cy + gap - 2 });
    }
    candidates.push({ x: cx - width / 2, y: cy - height / 2 });
  }
  const inside = (at: { x: number; y: number }) => ({
    x: Math.min(Math.max(at.x, 0), Math.max(bounds.width - width, 0)),
    y: Math.min(Math.max(at.y, 0), Math.max(bounds.height - height, 0)),
  });
  const fits = (at: { x: number; y: number }) =>
    at.x >= 0 && at.y >= 0 && at.x + width <= bounds.width && at.y + height <= bounds.height;
  const overlap = (at: { x: number; y: number }) =>
    obstacles.reduce((sum, box) => sum + overlapArea({ ...at, width, height }, box), 0);
  let at = candidates.find((each) => fits(each) && overlap(each) === 0);
  if (at === undefined) {
    // In the candidates' order, so ties go to the spot nearest the edge.
    let least = Infinity;
    for (const each of candidates.map(inside)) {
      const area = overlap(each);
      if (area < least) [at, least] = [each, area];
    }
  }
  at ??= inside({ x: points[0]?.[0] ?? 0, y: points[0]?.[1] ?? 0 });
  return { x: round(at.x), y: round(at.y), width, height };
}

// How much two rectangles overlap, each grown by the 2px `overlaps` keeps between them.
const overlapArea = (a: Rect, b: Rect) =>
  overlaps(a, b)
    ? Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) + 2) *
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) + 2)
    : 0;

// Whether two rectangles come within 2px of each other.
export const overlaps = (a: Rect, b: Rect) =>
  !(a.x + a.width + 2 < b.x || b.x + b.width + 2 < a.x || a.y + a.height + 2 < b.y || b.y + b.height + 2 < a.y);

// To a tenth of a pixel, which keeps the page small without moving anything the eye can see.
const round = (n: number) => Math.round(n * 10) / 10;
