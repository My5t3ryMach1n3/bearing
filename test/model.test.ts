import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modelFromWorkspace } from "../src/model.js";

// Exported by the pinned Structurizr from test/fixtures/diff/before/workspace.dsl.
const before = modelFromWorkspace(
  JSON.parse(readFileSync(new URL("fixtures/diff/before.json", import.meta.url), "utf8")) as Record<string, unknown>,
);

describe("modelFromWorkspace", () => {
  it("keys elements by DSL identifier, falling back to parent and name for anonymous ones", () => {
    expect([...before.elements.keys()].sort()).toEqual([
      "basket",
      "basketApi",
      "basketApi/Audit log",
      "basketController",
      "basketRepository",
      "basketService",
      "db",
      "email",
      "shopper",
      "webApp",
    ]);
  });

  it("reads bearing.path, bearing.requirements and user tags", () => {
    expect(before.elements.get("basketService")).toEqual({
      id: "basketService",
      type: "component",
      name: "Basket service",
      description: "Adds, removes and persists basket items",
      technology: "",
      tags: ["Service"],
      parent: "basketApi",
      path: "src/basket-api/basket-service",
      requirements: ["#1", "#2", "#4"],
      properties: {},
    });
    expect(before.elements.get("email")).toMatchObject({ type: "softwareSystem", tags: ["External"] });
  });

  it("keys relationships by source and destination, skipping the ones Structurizr implies", () => {
    expect([...before.relationships.keys()].sort()).toEqual([
      "basketController->basketService[addItem()]",
      "basketController->basketService[removeItem()]",
      "basketRepository->db",
      "basketService->basketRepository",
      "basketService->email",
      "lb->ecs",
      "shopper->webApp",
      "webApp->basketController",
    ]);
    expect(before.relationships.get("webApp->basketController")).toEqual({
      id: "webApp->basketController",
      source: "webApp",
      destination: "basketController",
      description: "Calls",
      technology: "HTTPS",
      tags: [],
      requirements: [],
      properties: {},
    });
  });

  it("resolves dynamic view steps to stable IDs, in order", () => {
    expect(before.dynamicViews.get("req-2")).toEqual({
      id: "req-2",
      scope: "basketApi",
      description: "#2 Add an item to the basket",
      steps: [
        { order: "1", source: "webApp", destination: "basketController", description: "POST /basket/items" },
        { order: "2", source: "basketController", destination: "basketService", description: "addItem()" },
        { order: "3", source: "basketService", destination: "basketRepository", description: "save()" },
      ],
    });
  });

  it("reads deployment nodes, infrastructure nodes and instances", () => {
    expect([...before.deployment.keys()].sort()).toEqual(["aws", "ecs", "ecs/basketApi", "lb", "rds", "rds/db"]);
    expect(before.deployment.get("ecs")).toMatchObject({ parent: "aws", technology: "Fargate", instances: "2" });
    expect(before.deployment.get("lb")).toMatchObject({ type: "infrastructureNode", parent: "aws" });
    expect(before.deployment.get("ecs/basketApi")).toMatchObject({
      type: "containerInstance",
      name: "Basket API",
      parent: "ecs",
      element: "basketApi",
    });
  });

  it("numbers anonymous siblings that share a name", () => {
    const anonymous = (id: string) => ({
      id,
      name: "Worker",
      properties: { "structurizr.dsl.identifier": "5d1f7c2e-0b8a-4c3e-9f61-2a7d9e4b8c10" },
    });
    const model = modelFromWorkspace({
      model: { softwareSystems: [{ id: "1", name: "Jobs", containers: [anonymous("2"), anonymous("3")] }] },
    });
    expect([...model.elements.keys()]).toEqual(["Jobs", "Jobs/Worker", "Jobs/Worker#2"]);
  });

  it("reads an empty workspace", () => {
    expect(modelFromWorkspace({})).toEqual({
      elements: new Map(),
      relationships: new Map(),
      dynamicViews: new Map(),
      deployment: new Map(),
    });
  });
});
