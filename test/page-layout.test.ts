import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { describe, expect, it } from "vitest";
import { modelFromWorkspace, type Model } from "../src/model.js";
import { buildPageData, elementStyles, type PageData, type PageLevel } from "../src/page-data.js";
import {
  driftLabel,
  joinSections,
  layOutLevel,
  layOutLevels,
  orderSections,
  overlaps,
  pathOf,
  placeLabel,
  straighten,
  toPageFrame,
  type LaidEdge,
  type LevelLayout,
  type Point,
} from "../src/page-layout.js";
import { skipped } from "./checks.js";

const fixtures = join(import.meta.dirname, "fixtures");
const workspace = (...path: string[]) => JSON.parse(readFileSync(join(fixtures, ...path), "utf8"));

function pageOf(forked: Model, target: Model, check = skipped(), styles = elementStyles({})): PageData {
  return buildPageData({
    check,
    target,
    forked,
    targetFiles: [],
    adrs: [],
    changes: [],
    sourceFiles: [],
    styles,
  });
}

// The basket's sharing design on top of its initial target, with the controller importing the repository.
function basketPage(): PageData {
  const check = skipped();
  check.checks[3] = {
    check: "boundaries",
    status: "failed",
    blocking: true,
    undeclared: [
      {
        id: "basketController->basketRepository",
        source: "basketController",
        destination: "basketRepository",
        imports: [
          { file: "src/basket-api/basket-controller/index.ts", line: 3, module: "../basket-repository/index.js" },
        ],
      },
    ],
    queues: [],
  };
  return pageOf(
    modelFromWorkspace(workspace("target-changes", "initial.json")),
    modelFromWorkspace(workspace("target-changes", "sharing.json")),
    check,
  );
}

const level = (overrides: Partial<PageLevel>): PageLevel => ({
  id: "context",
  kind: "context",
  title: "System context",
  nodes: [],
  edges: [],
  drift: [],
  ...overrides,
});
const edge = (source: string, destination: string, label = "") => ({
  id: `${source}->${destination}`,
  source,
  destination,
  relationships: [],
  label,
  inBefore: true,
  inAfter: true,
});

describe("moving ELK's output to the page's frame", () => {
  it("places each shape relative to its parent", () => {
    const laid: ElkNode = {
      id: "root",
      children: [
        {
          id: "outer",
          x: 10,
          y: 20,
          width: 300,
          height: 200,
          children: [{ id: "inner", x: 5, y: 7, width: 50, height: 40 }],
        },
        { id: "beside", x: 400, y: 0, width: 50, height: 40 },
      ],
    };
    const { shapes, origins } = toPageFrame(laid);
    expect(shapes.get("outer")).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(shapes.get("inner")).toEqual({ x: 15, y: 27, width: 50, height: 40 });
    expect(shapes.get("beside")).toEqual({ x: 400, y: 0, width: 50, height: 40 });
    expect(origins.get("inner")).toEqual([15, 27]);
  });

  it("moves each edge by its container's origin", async () => {
    // What elkjs 0.9.3 gives back for an edge between two children of the boundary: the boundary is its container, and
    // its points are relative to it.
    const fake = async (graph: ElkNode): Promise<ElkNode> => ({
      ...graph,
      width: 500,
      height: 400,
      children: [
        {
          id: "boundary",
          x: 100,
          y: 50,
          width: 300,
          height: 300,
          children: [
            { id: "n0", x: 24, y: 36, width: 190, height: 76 },
            { id: "n1", x: 24, y: 200, width: 190, height: 76 },
          ],
          edges: [
            {
              id: "e0",
              sources: ["n0"],
              targets: ["n1"],
              container: "boundary",
              sections: [{ id: "s0", startPoint: { x: 119, y: 112 }, endPoint: { x: 119, y: 200 } }],
            } as LaidEdge,
          ],
        },
      ],
    });
    const laid = await layOutLevel(
      level({ id: "s", kind: "containers", scope: "s", nodes: ["a", "b"], edges: [edge("a", "b")] }),
      { a: { parent: "s" }, b: { parent: "s" }, s: { name: "Shop" } } as unknown as PageData["elements"],
      fake,
    );
    expect(laid.boundary).toEqual({ x: 100, y: 50, width: 300, height: 300 });
    expect(laid.shapes).toEqual({
      a: { x: 124, y: 86, width: 190, height: 76 },
      b: { x: 124, y: 250, width: 190, height: 76 },
    });
    expect(laid.routes["a->b"]!.points).toEqual([
      [219, 162],
      [219, 250],
    ]);
  });
});

describe("joining an edge's sections", () => {
  const section = (id: string, from: number, to: number, incoming: string[] = [], outgoing: string[] = []) => ({
    id,
    startPoint: { x: from, y: from },
    endPoint: { x: to, y: to },
    incomingSections: incoming,
    outgoingSections: outgoing,
  });

  it("orders them from the one nothing leads into", () => {
    const sections = [section("c", 2, 3, ["b"]), section("a", 0, 1, [], ["b"]), section("b", 1, 2, ["a"], ["c"])];
    expect(orderSections(sections).map((each) => each.id)).toEqual(["a", "b", "c"]);
  });

  it("stops at a cycle", () => {
    const sections = [section("a", 0, 1, ["b"], ["b"]), section("b", 1, 0, ["a"], ["a"])];
    expect(orderSections(sections).map((each) => each.id)).toEqual(["a", "b"]);
  });

  it("joins their points without repeating where one ends and the next starts", () => {
    expect(
      joinSections([
        [
          [0, 0],
          [1, 1],
        ],
        [
          [1, 1],
          [2, 2],
        ],
      ]),
    ).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });
});

describe("drawing a spline", () => {
  const points = (n: number): Point[] => Array.from({ length: n }, (_, i): Point => [i, i * 10]);

  it("draws control points in threes as cubic curves", () => {
    expect(pathOf([points(7)])).toBe("M0,0 C1,10 2,20 3,30 C4,40 5,50 6,60");
  });

  it("ends with a quadratic curve when two points are left over", () => {
    expect(pathOf([points(6)])).toBe("M0,0 C1,10 2,20 3,30 Q4,40 5,50");
  });

  it("ends with a straight run when one is left over", () => {
    expect(pathOf([points(5)])).toBe("M0,0 C1,10 2,20 3,30 L4,40");
    expect(pathOf([points(2)])).toBe("M0,0 L1,10");
  });

  it("draws each section on its own, so a remainder in one doesn't shift the next", () => {
    const first: Point[] = [
      [0, 0],
      [1, 1],
      [2, 2],
    ];
    const second: Point[] = [
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ];
    expect(pathOf([first, second])).toBe("M0,0 Q1,1 2,2 C3,3 4,4 5,5");
  });
});

describe("straightening runs of straight pieces", () => {
  it("merges straight pieces along one line into one", () => {
    const points: Point[] = [
      [0, 0],
      [0, 10],
      [0, 20],
      [0, 30],
      [0, 40],
      [0, 50],
      [0, 60],
    ];
    expect(straighten(points)).toEqual([
      [0, 0],
      [0, 20],
      [0, 40],
      [0, 60],
    ]);
  });

  it("keeps curved pieces, and straight ones that turn", () => {
    const curve: Point[] = [
      [0, 0],
      [10, 0],
      [20, 10],
      [20, 20],
      [20, 30],
      [20, 40],
      [20, 50],
    ];
    expect(straighten(curve)).toEqual(curve);
    const corner: Point[] = [
      [0, 0],
      [0, 10],
      [0, 20],
      [0, 30],
      [10, 30],
      [20, 30],
      [30, 30],
    ];
    expect(straighten(corner)).toEqual(corner);
  });

  it("keeps what's left over after the threes", () => {
    const points: Point[] = [
      [0, 0],
      [0, 10],
      [0, 20],
      [0, 30],
      [0, 40],
      [0, 50],
      [0, 60],
      [5, 70],
    ];
    expect(straighten(points)).toEqual([
      [0, 0],
      [0, 20],
      [0, 40],
      [0, 60],
      [5, 70],
    ]);
  });
});

describe("placing labels", () => {
  const bounds = { width: 1000, height: 1000 };
  const vertical: Point[] = [
    [500, 100],
    [500, 500],
  ];

  it("goes beside the middle of a vertical run when it's clear", () => {
    expect(placeLabel(vertical, 80, [], bounds)).toEqual({ x: 506, y: 293, width: 80, height: 14 });
  });

  it("moves clear of a box in the way", () => {
    const box = { x: 450, y: 250, width: 200, height: 100 };
    const label = placeLabel(vertical, 80, [box], bounds);
    expect(overlaps(label, box)).toBe(false);
  });

  it("moves clear of a label already placed", () => {
    const first = placeLabel(vertical, 80, [], bounds);
    const second = placeLabel(vertical, 80, [first], bounds);
    expect(overlaps(first, second)).toBe(false);
  });

  it("stays inside the diagram", () => {
    const label = placeLabel(
      [
        [5, 0],
        [5, 100],
      ],
      200,
      [],
      { width: 300, height: 100 },
    );
    expect(label.x).toBeGreaterThanOrEqual(0);
    expect(label.x + label.width).toBeLessThanOrEqual(300);
  });

  it("goes over its own edge when neither side is clear", () => {
    const left = { x: 300, y: 0, width: 194, height: 1000 };
    const right = { x: 506, y: 0, width: 194, height: 1000 };
    const label = placeLabel(vertical, 80, [left, right], bounds);
    expect(label).toEqual({ x: 460, y: 293, width: 80, height: 14 });
  });

  it("overlaps as little as it can when nowhere is clear", () => {
    const wall = { x: 0, y: 0, width: 1000, height: 296 };
    const label = placeLabel(vertical, 80, [wall], bounds);
    // Below the wall, as near the middle of the edge as that allows.
    expect(label.y).toBeGreaterThanOrEqual(298);
    expect(overlaps(label, wall)).toBe(false);
  });
});

describe("laying out the basket", () => {
  it("lays out every level, with a box for every node and a route for every edge", async () => {
    const data = basketPage();
    const layouts = await layOutLevels(data);
    expect(Object.keys(layouts)).toEqual(data.levels.map((each) => each.id));
    for (const each of data.levels) {
      const laid = layouts[each.id]!;
      expect(Object.keys(laid.shapes).sort()).toEqual([...each.nodes].sort());
      expect(Object.keys(laid.routes).sort()).toEqual([...each.edges, ...each.drift].map((edge) => edge.id).sort());
      expect(laid.boundary === undefined).toBe(each.scope === undefined);
    }
    // The undeclared import from the controller to the repository is drawn, and labelled.
    const components = data.levels.find((each) => each.kind === "components" && each.drift.length > 0)!;
    const drift = layouts[components.id]!.routes[components.drift[0]!.id]!;
    expect(drift.label?.width).toBe(Math.round(6.4 * driftLabel.length + 8));
  });

  it("keeps the scope's children inside its boundary", async () => {
    const data = basketPage();
    const layouts = await layOutLevels(data);
    for (const each of data.levels.filter((one) => one.scope !== undefined)) {
      const { boundary, shapes } = layouts[each.id]!;
      for (const id of each.nodes.filter((node) => data.elements[node]?.parent === each.scope)) {
        const box = shapes[id]!;
        expect(box.x).toBeGreaterThanOrEqual(boundary!.x);
        expect(box.y).toBeGreaterThanOrEqual(boundary!.y);
        expect(box.x + box.width).toBeLessThanOrEqual(boundary!.x + boundary!.width);
        expect(box.y + box.height).toBeLessThanOrEqual(boundary!.y + boundary!.height);
      }
    }
  });

  it("places every label inside the diagram, and nearly all clear of every box and every other label", async () => {
    const layouts = await layOutLevels(basketPage());
    let labels = 0;
    let crowded = 0;
    for (const laid of Object.values(layouts)) {
      const placed = Object.values(laid.routes).flatMap((route) => (route.label === undefined ? [] : [route.label]));
      labels += placed.length;
      for (const label of placed) {
        expect(label.x).toBeGreaterThanOrEqual(0);
        expect(label.y).toBeGreaterThanOrEqual(0);
        expect(label.x + label.width).toBeLessThanOrEqual(laid.width);
        expect(label.y + label.height).toBeLessThanOrEqual(laid.height);
        const others = placed.filter((other) => other !== label);
        if ([...Object.values(laid.shapes), ...others].some((box) => overlaps(label, box))) crowded++;
      }
    }
    // Where several edges leave one box between close layers, there can be no clear spot for every label (#116 leaves
    // this for later); the basket has a few such labels out of 28.
    expect(labels).toBe(28);
    expect(crowded).toBeLessThanOrEqual(6);
  });

  it("is the same across runs", async () => {
    const first = JSON.stringify(await layOutLevels(basketPage()));
    const second = JSON.stringify(await layOutLevels(basketPage()));
    expect(second).toBe(first);
  });
});

// The spike's bench (spikes/architecture-page/bench.mjs) measured its layout at 1.19 curves per edge on the basket and
// 1.24 on a generated shop of about 30 elements (`fixtures/page-layout/shop.json`), counting a curve for every three
// control points or part of three. This layout takes 1.20 on the shop, and on the basket the same 31 curves for the
// spike's 26 edges, plus 2 for an edge the spike didn't draw: the shopper signing in with the identity provider, on the
// basket's containers level, which C4 draws there as it lies between two elements outside the scope. These hold it to
// about one curve per edge.
describe("how many curves the edges take", () => {
  const curvesPerEdge = (layouts: Record<string, LevelLayout>) => {
    const routes = Object.values(layouts).flatMap((laid) => Object.values(laid.routes));
    const curves = routes.reduce((sum, route) => sum + Math.ceil((route.points.length - 1) / 3), 0);
    return curves / routes.length;
  };
  const alone = (...path: string[]) => {
    const json = workspace(...path);
    const model = modelFromWorkspace(json);
    return pageOf(model, model, skipped(), elementStyles(json));
  };

  it("takes about one curve per edge on the basket", async () => {
    expect(curvesPerEdge(await layOutLevels(alone("target-changes", "sharing.json")))).toBeLessThanOrEqual(1.25);
  });

  it("takes about one curve per edge on the generated shop", async () => {
    expect(curvesPerEdge(await layOutLevels(alone("page-layout", "shop.json")))).toBeLessThanOrEqual(1.25);
  });
});
