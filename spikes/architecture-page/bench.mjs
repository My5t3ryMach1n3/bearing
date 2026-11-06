#!/usr/bin/env node
// Compares ELK options by how many turns the edges take, over every level of the fixtures' models and a larger
// generated one. A turn is a bend point of an orthogonal or polyline edge; a spline's are curves, counted separately.
//
//   node bench.mjs
//   node bench.mjs --write-generated <file.json>    writes the generated model, to build a page of it
//
// Imports Bearing from ../../dist, so run `npm run build` at the repo root first.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelFromWorkspace } from "../../dist/model.js";
import { pageData } from "./page.mjs";

const fixtures = join(import.meta.dirname, "..", "..", "test", "fixtures");
const workspaces = {
  basket: JSON.parse(readFileSync(join(fixtures, "target-changes", "sharing.json"), "utf8")),
  reminders: JSON.parse(readFileSync(join(fixtures, "reminders", "workspace.json"), "utf8")),
  generated: generated(),
};

const straight = {
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
};
const configs = {
  "orthogonal, ELK places labels (before)": { labels: "layout", elk: {} },
  "orthogonal, labels after": { labels: "after", elk: {} },
  "orthogonal, labels after, BK balanced": { labels: "after", elk: straight },
  "orthogonal, labels after, BK, straight edges": {
    labels: "after",
    elk: { ...straight, "elk.layered.nodePlacement.favorStraightEdges": "true" },
  },
  "polyline, labels after, BK balanced": { labels: "after", elk: { ...straight, "elk.edgeRouting": "POLYLINE" } },
  "splines, labels after, BK balanced": { labels: "after", elk: { ...straight, "elk.edgeRouting": "SPLINES" } },
};

if (process.argv[2] === "--write-generated") {
  writeFileSync(process.argv[3], JSON.stringify(workspaces.generated));
  process.exit(0);
}

const rows = [];
for (const [config, layout] of Object.entries(configs)) {
  const row = { config };
  for (const [name, workspace] of Object.entries(workspaces)) {
    const model = modelFromWorkspace(workspace);
    const data = await pageData(model, model, { checks: [] }, { layout });
    let turns = 0;
    let curves = 0;
    let edges = 0;
    let area = 0;
    for (const level of data.levels) {
      area += level.layout.width * level.layout.height;
      for (const route of Object.values(level.layout.routes)) {
        edges++;
        if (route.curve) curves += Math.ceil((route.points.length - 1) / 3);
        else turns += route.points.length - 2;
      }
    }
    row[name] = layout.elk["elk.edgeRouting"] === "SPLINES" ? `${curves} curves` : `${turns} turns`;
    row[`${name} per edge`] = (layout.elk["elk.edgeRouting"] === "SPLINES" ? curves : turns) / edges;
    row[`${name} area`] = Math.round(area / 1000);
  }
  rows.push(row);
}
console.table(
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === "number" ? Number(value.toFixed(2)) : value]),
    ),
  ),
);

// A shop of about 30 elements: two people, a web and a mobile app, an API of eleven components, a worker of five, a
// database, a queue, and four external systems. The relationships are fixed, so every run lays out the same model.
function generated() {
  let id = 0;
  const item = (name, extra = {}) => ({ id: String(++id), name, description: "", ...extra, relationships: [] });
  const shopper = item("Shopper", { tags: "Element,Person" });
  const staff = item("Staff", { tags: "Element,Person" });
  const component = (name) => item(name, { tags: "Element,Component" });
  const api = [
    "Auth",
    "Catalogue controller",
    "Basket controller",
    "Order controller",
    "Catalogue service",
    "Basket service",
    "Order service",
    "Payment client",
    "Stock client",
    "Order repository",
    "Event publisher",
  ].map(component);
  const worker = ["Event consumer", "Fulfilment", "Emailer", "Invoice builder", "Shipping client"].map(component);
  const container = (name, technology, components = [], tags = "Element,Container") =>
    item(name, { technology, tags, components });
  const web = container("Web app", "TypeScript, React");
  const mobile = container("Mobile app", "Swift, iOS");
  const apiContainer = container("Shop API", "TypeScript, Node.js", api);
  const workerContainer = container("Order worker", "Python", worker);
  const database = container("Database", "PostgreSQL", [], "Element,Container,Database");
  const queue = container("Order events", "Amazon SQS", [], "Element,Container,Queue");
  const shop = item("Shop", {
    tags: "Element,Software System",
    containers: [web, mobile, apiContainer, workerContainer, database, queue],
  });
  const external = (name) => item(name, { tags: "Element,Software System,External" });
  const payments = external("Payment provider");
  const stock = external("Warehouse");
  const email = external("Email provider");
  const carrier = external("Carrier");
  const byName = new Map(
    [shopper, staff, web, mobile, ...api, ...worker, database, queue, payments, stock, email, carrier].map((each) => [
      each.name,
      each,
    ]),
  );
  const links = [
    ["Shopper", "Web app", "Shops using"],
    ["Shopper", "Mobile app", "Shops using"],
    ["Staff", "Web app", "Manages orders using"],
    ["Web app", "Auth", "Signs in using", "JSON/HTTPS"],
    ["Web app", "Catalogue controller", "Browses products using", "JSON/HTTPS"],
    ["Web app", "Basket controller", "Fills baskets using", "JSON/HTTPS"],
    ["Web app", "Order controller", "Places orders using", "JSON/HTTPS"],
    ["Mobile app", "Catalogue controller", "Browses products using", "JSON/HTTPS"],
    ["Mobile app", "Basket controller", "Fills baskets using", "JSON/HTTPS"],
    ["Mobile app", "Order controller", "Places orders using", "JSON/HTTPS"],
    ["Catalogue controller", "Catalogue service", "Looks up products with"],
    ["Basket controller", "Basket service", "Changes baskets with"],
    ["Order controller", "Order service", "Places orders with"],
    ["Order controller", "Auth", "Checks sessions with"],
    ["Basket controller", "Auth", "Checks sessions with"],
    ["Catalogue service", "Stock client", "Checks stock with"],
    ["Basket service", "Catalogue service", "Prices items with"],
    ["Order service", "Basket service", "Reads the basket with"],
    ["Order service", "Payment client", "Takes payment with"],
    ["Order service", "Order repository", "Saves orders with"],
    ["Order service", "Event publisher", "Announces orders with"],
    ["Basket service", "Database", "Reads and writes baskets in", "SQL"],
    ["Order repository", "Database", "Reads and writes orders in", "SQL"],
    ["Catalogue service", "Database", "Reads products from", "SQL"],
    ["Payment client", "Payment provider", "Charges cards with", "JSON/HTTPS"],
    ["Stock client", "Warehouse", "Reads stock levels from", "JSON/HTTPS"],
    ["Event publisher", "Order events", "Sends order events to"],
    ["Order events", "Event consumer", "Delivers order events to"],
    ["Event consumer", "Fulfilment", "Fulfils orders with"],
    ["Fulfilment", "Shipping client", "Books shipping with"],
    ["Fulfilment", "Invoice builder", "Builds invoices with"],
    ["Fulfilment", "Emailer", "Tells the shopper with"],
    ["Emailer", "Email provider", "Sends email with", "SMTP"],
    ["Shipping client", "Carrier", "Books collections with", "JSON/HTTPS"],
    ["Invoice builder", "Database", "Reads orders from", "SQL"],
  ];
  for (const [source, destination, description, technology = ""] of links) {
    byName.get(source).relationships.push({
      id: String(++id),
      sourceId: byName.get(source).id,
      destinationId: byName.get(destination).id,
      description,
      technology,
    });
  }
  return {
    model: { people: [shopper, staff], softwareSystems: [shop, payments, stock, email, carrier] },
    views: { configuration: { styles: { elements: [{ tag: "Database", shape: "Cylinder" }] } } },
  };
}
