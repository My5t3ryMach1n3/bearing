import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { deriveKubernetes, parseManifests, readKubernetes } from "../src/kubernetes.js";
import { modelFromWorkspace } from "../src/model.js";
import { routeFor, serviceRoutes } from "../src/services.js";

const clinicDir = join(import.meta.dirname, "fixtures", "clinic");
const config = loadConfig(join(clinicDir, "repo"));
const target = modelFromWorkspace(JSON.parse(readFileSync(join(clinicDir, "workspace.json"), "utf8")));
const manifests = readKubernetes(config);
const routes = serviceRoutes(target, manifests, deriveKubernetes(config, target, manifests));

describe("serviceRoutes", () => {
  it("follows each Service's selector to the container its workload's node runs", () => {
    expect(routes.map(({ address, container, ports }) => [address, container, ports])).toEqual([
      ["Service/chairside/booking-api", "bookingApi", [8000]],
      ["Service/chairside/postgres", "database", [5432]],
      ["Service/chairside/web", "webApp", [80]],
    ]);
  });

  it("leaves out a Service with no selector, or one whose pods are no target node's", () => {
    const extra = parseManifests(
      [
        "apiVersion: v1",
        "kind: Service",
        "metadata: { name: external, namespace: chairside }",
        "spec: { type: ExternalName, externalName: api.example.com }",
        "---",
        "apiVersion: v1",
        "kind: Service",
        "metadata: { name: redis, namespace: chairside }",
        "spec: { selector: { app: redis } }",
        "---",
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata: { name: redis, namespace: chairside }",
        "spec: { template: { metadata: { labels: { app: redis } } } }",
        "---",
        "apiVersion: v1",
        "kind: Service",
        "metadata: { name: web-elsewhere, namespace: other }",
        "spec: { selector: { app: web } }",
      ].join("\n"),
      "k8s/extra.yaml",
    );
    const all = [...manifests, ...extra];
    const found = serviceRoutes(target, all, deriveKubernetes(config, target, all)).map((route) => route.address);
    expect(found).toEqual(["Service/chairside/booking-api", "Service/chairside/postgres", "Service/chairside/web"]);
  });
});

describe("routeFor", () => {
  it("reaches a Service by its name as cluster DNS resolves it, on a port it exposes", () => {
    for (const host of [
      "booking-api",
      "booking-api.chairside",
      "booking-api.chairside.svc",
      "Booking-API.chairside.svc.cluster.local.",
    ]) {
      expect(routeFor(routes, host)?.container, host).toBe("bookingApi");
    }
    expect(routeFor(routes, "booking-api", 8000)?.container).toBe("bookingApi");
  });

  it("reaches nothing on another port, namespace or domain, or on localhost", () => {
    expect(routeFor(routes, "booking-api", 9000)).toBeUndefined();
    expect(routeFor(routes, "booking-api.other")).toBeUndefined();
    expect(routeFor(routes, "booking-api.chairside.example.com")).toBeUndefined();
    expect(routeFor(routes, "localhost", 8000)).toBeUndefined();
  });

  it("reaches neither of two Services a short name could mean", () => {
    const twice = [...routes, { ...routes[0]!, address: "Service/staging/booking-api", namespace: "staging" }];
    expect(routeFor(twice, "booking-api")).toBeUndefined();
    expect(routeFor(twice, "booking-api.staging")?.address).toBe("Service/staging/booking-api");
  });
});
