import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { edgesAt, elementsAt, levelsOf } from "../src/levels.js";
import { modelFromWorkspace, type Element, type Model } from "../src/model.js";

const load = (name: string) =>
  modelFromWorkspace(
    JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "target-changes", `${name}.json`), "utf8")),
  );

const byId = (model: Model) => (id: string) => levelsOf(model).find((level) => level.id === id)!;

describe("the levels of the sharing design", () => {
  const model = load("sharing");
  const level = byId(model);

  it("has the system context, each software system's containers and each container's components", () => {
    expect(levelsOf(model).map((each) => [each.id, each.kind, each.parent])).toEqual([
      ["context", "context", undefined],
      ["basket", "containers", "context"],
      ["basketApi", "components", "basket"],
    ]);
  });

  it("lifts a component to its software system at the system context", () => {
    expect(level("context").at("emailOutbox")).toBe("basket");
    expect(level("context").at("shopper")).toBe("shopper");
  });

  it("lifts a component to its container on its system's containers level", () => {
    expect(level("basket").at("emailOutbox")).toBe("basketApi");
    expect(level("basket").at("database")).toBe("database");
    expect(level("basket").at("emailProvider")).toBe("emailProvider");
    expect(level("basket").at("basket")).toBeUndefined();
  });

  it("keeps a container's own components, and lifts what's outside it", () => {
    expect(level("basketApi").at("emailOutbox")).toBe("emailOutbox");
    expect(level("basketApi").at("webApp")).toBe("webApp");
    expect(level("basketApi").at("basketApi")).toBeUndefined();
  });

  it("joins the relationships lifted between two elements into one edge", () => {
    const edges = edgesAt(model, level("context"));
    expect(edges.get("basket->emailProvider")).toEqual({
      source: "basket",
      destination: "emailProvider",
      relationships: ["emailOutbox->emailProvider"],
      label: "Sends queued email with, on a schedule",
    });
    expect([...edges.keys()]).not.toContain("basket->basket");
  });

  it("names the direct relationship, when one joins the two elements", () => {
    const edge = edgesAt(model, level("basketApi")).get("webApp->basketController")!;
    expect(edge.direct).toBe("webApp->basketController");
    expect(edge.label).toBe("Makes API calls to");
  });

  it("holds what's inside the scope and what it connects to, and the relationships between them", () => {
    const held = elementsAt(model, level("basket"));
    expect([...held].sort()).toEqual(
      ["database", "emailProvider", "identityProvider", "productCatalogue", "shopper", "webApp", "basketApi"].sort(),
    );
    // Neither end is in Basket, but both are on its containers diagram, as C4 draws it.
    expect(edgesAt(model, level("basket")).has("shopper->identityProvider")).toBe(true);
    // Components level: the shopper connects to nothing inside Basket API.
    expect(elementsAt(model, level("basketApi")).has("shopper")).toBe(false);
  });
});

describe("a model with two software systems that have containers", () => {
  const model = load("sharing");
  const add = (element: Partial<Element> & Pick<Element, "id" | "type" | "name">) =>
    model.elements.set(element.id, {
      description: "",
      technology: "",
      tags: [],
      requirements: [],
      properties: {},
      ...element,
    });
  add({ id: "orders", type: "softwareSystem", name: "Orders" });
  add({ id: "ordersApi", type: "container", name: "Orders API", parent: "orders" });
  model.relationships.set("emailOutbox->ordersApi", {
    id: "emailOutbox->ordersApi",
    source: "emailOutbox",
    destination: "ordersApi",
    description: "Tells",
    technology: "",
    tags: [],
    requirements: [],
    properties: {},
  });
  const level = byId(model);

  it("gives each its own containers level", () => {
    expect(levelsOf(model).map((each) => each.id)).toEqual(["context", "basket", "orders", "basketApi"]);
  });

  it("draws the other system's containers as the system on each one's level", () => {
    expect(level("basket").at("ordersApi")).toBe("orders");
    expect(level("orders").at("emailOutbox")).toBe("basket");
    expect(edgesAt(model, level("orders")).has("basket->ordersApi")).toBe(true);
    expect(edgesAt(model, level("basketApi")).has("emailOutbox->orders")).toBe(true);
  });
});
