import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDeployment, formatCheck, type DeploymentCheck } from "../src/check.js";
import { loadConfig, parseConfig } from "../src/config.js";
import { diffModels } from "../src/diff.js";
import { asBuiltDeployment, deriveDeployment } from "../src/iac.js";
import { deriveKubernetes, kindMappings, KubernetesError, parseManifests, supportingKinds } from "../src/kubernetes.js";
import { modelFromWorkspace, type DeploymentElement, type Model } from "../src/model.js";

const clinicDir = join(import.meta.dirname, "fixtures", "clinic");
const clinicTarget = () => modelFromWorkspace(JSON.parse(readFileSync(join(clinicDir, "workspace.json"), "utf8")));

// The clinic fixture's repo, with a variant's files laid over it. See test/fixtures/clinic/README.md.
function clinic(variant?: "redis-cache" | "scaled-api") {
  const root = mkdtempSync(join(tmpdir(), "bearing-clinic-"));
  cpSync(join(clinicDir, "repo"), root, { recursive: true });
  if (variant !== undefined) cpSync(join(clinicDir, "variants", variant), root, { recursive: true });
  return loadConfig(root);
}

// A target whose deployment is one node per `id: technology`, all in "Production".
function target(nodes: Record<string, string | Partial<DeploymentElement>>): Model {
  const deployment = new Map<string, DeploymentElement>();
  for (const [id, node] of Object.entries(nodes)) {
    deployment.set(id, {
      id,
      type: "deploymentNode",
      environment: "Production",
      name: id,
      description: "",
      technology: "",
      tags: [],
      properties: {},
      ...(typeof node === "string" ? { technology: node } : node),
    });
  }
  return { elements: new Map(), relationships: new Map(), dynamicViews: new Map(), deployment };
}

// Writes files into a temp repo whose config reads `k8s/`.
function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "bearing-kubernetes-"));
  mkdirSync(join(root, "k8s"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return parseConfig(
    "version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\niac:\n  kubernetes: k8s/\n",
    root,
  );
}

const deployment = (name: string, replicas?: number) =>
  [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    ...(replicas === undefined ? [] : [`  replicas: ${replicas}`]),
    "  template: {}",
  ].join("\n");

const diffOf = (model: Model, config: ReturnType<typeof repo>) => {
  const diff = diffModels(model, asBuiltDeployment(model, deriveDeployment(config, model)!)).deployment;
  return {
    added: diff.added.map(({ id }) => id),
    removed: diff.removed.map(({ id }) => id),
    drifted: diff.drifted,
  };
};

const deploymentCheck = (model: Model, config: ReturnType<typeof repo>) => {
  const result = checkDeployment(model, deriveDeployment(config, model)!);
  const failed = result.added.length + result.removed.length + result.drifted.length > 0;
  const check: DeploymentCheck = {
    check: "deployment",
    status: failed ? "failed" : "passed",
    blocking: true,
    ...result,
  };
  return formatCheck(check);
};

describe("parseManifests", () => {
  it("reads every document in a file with its line, group and namespace", () => {
    const manifests = parseManifests(
      [
        "# booking",
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: booking-api",
        "  namespace: chairside",
        "spec:",
        "  replicas: 2",
        "---",
        "---",
        "apiVersion: v1",
        "kind: Service",
        "metadata:",
        "  name: booking-api",
      ].join("\n"),
      "k8s/booking.yaml",
    );
    expect(manifests.map(({ group, kind, address, file, line }) => ({ group, kind, address, file, line }))).toEqual([
      {
        group: "apps",
        kind: "Deployment",
        address: "Deployment/chairside/booking-api",
        file: "k8s/booking.yaml",
        line: 2,
      },
      { group: "", kind: "Service", address: "Service/booking-api", file: "k8s/booking.yaml", line: 11 },
    ]);
  });

  it("reads a List as its items, and JSON as YAML", () => {
    const list = parseManifests(
      JSON.stringify(
        {
          apiVersion: "v1",
          kind: "List",
          items: [
            { apiVersion: "batch/v1", kind: "CronJob", metadata: { name: "reminders" } },
            { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "settings" } },
          ],
        },
        null,
        2,
      ),
      "k8s/list.json",
    );
    expect(list.map(({ address, line }) => [address, line])).toEqual([
      ["CronJob/reminders", 5],
      ["ConfigMap/settings", 12],
    ]);
  });

  it("refuses what isn't a Kubernetes object, with its file and line", () => {
    expect(() => parseManifests("a: 1\n", "k8s/x.yaml")).toThrow(
      new KubernetesError("k8s/x.yaml:1: not a Kubernetes object: it has no kind"),
    );
    expect(() => parseManifests("---\nkind: Pod\nmetadata: {}\n", "k8s/x.yaml")).toThrow(
      new KubernetesError("k8s/x.yaml:2: the Pod has no metadata.name"),
    );
    expect(() => parseManifests("kind: Pod\nmetadata:\n  name: [a\n", "k8s/x.yaml")).toThrow(/^k8s\/x\.yaml:\d+: /);
  });

  it("reads Go templates in a ConfigMap's data as text", () => {
    const text =
      "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: alerts }\ndata:\n  rule: 'Down: {{ $labels.pod }}'\n";
    expect(parseManifests(text, "k8s/alerts.yaml").map(({ address }) => address)).toEqual(["ConfigMap/alerts"]);
  });
});

describe("deriveKubernetes", () => {
  it("maps workload kinds to nodes and lists kinds it doesn't know", () => {
    const config = repo({
      "k8s/booking.yaml": deployment("booking-api", 3),
      "k8s/other.yml": [
        "apiVersion: v1",
        "kind: Service",
        "metadata: { name: booking-api }",
        "---",
        "apiVersion: v1",
        "kind: Service",
        "metadata: { name: public }",
        "spec: { type: LoadBalancer }",
        "---",
        "apiVersion: serving.knative.dev/v1",
        "kind: Service",
        "metadata: { name: knative }",
        "---",
        "apiVersion: argoproj.io/v1alpha1",
        "kind: Rollout",
        "metadata: { name: canary }",
        "---",
        "apiVersion: autoscaling/v2",
        "kind: HorizontalPodAutoscaler",
        "metadata: { name: booking-api }",
      ].join("\n"),
      "k8s/README.md": "not read",
      "k8s/nested/ignored.yaml": deployment("nested"),
    });
    const graph = deriveKubernetes(config, target({ "booking-api": "Kubernetes Deployment" }));
    expect(graph).toEqual({
      environment: "Production",
      source: "kubernetes",
      nodes: [
        {
          id: "Service/public",
          type: "infrastructureNode",
          technology: "Kubernetes LoadBalancer Service",
          resource: { address: "Service/public", file: "k8s/other.yml", line: 5 },
        },
        {
          id: "booking-api",
          type: "deploymentNode",
          technology: "Kubernetes Deployment",
          instances: "3",
          resource: { address: "Deployment/booking-api", file: "k8s/booking.yaml", line: 1 },
        },
      ],
      unknown: [
        { address: "Rollout/canary", file: "k8s/other.yml", line: 14 },
        { address: "Service/knative", file: "k8s/other.yml", line: 10 },
      ],
    });
  });

  it("matches by bearing.kubernetes, then by name, then by technology", () => {
    const config = repo({
      "k8s/apps.yaml": [
        deployment("booking-api"),
        deployment("web"),
        deployment("admin"),
        deployment("reports"),
        "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: web }",
      ].join("\n---\n"),
    });
    const graph = deriveKubernetes(
      config,
      target({
        // Pinned, so its name doesn't matter.
        db: { name: "web", technology: "PostgreSQL", properties: { "bearing.kubernetes": "Deployment/booking-api" } },
        // "Web" is "web", and the Ingress named web isn't a deployment node, so it doesn't make the name ambiguous.
        front: { name: "Web", technology: "nginx" },
        // Two Deployments are left of one kind, so neither is matched by technology.
        other: "Kubernetes Deployment",
        edge: { type: "infrastructureNode", technology: "Traefik Ingress" },
      }),
    );
    expect(graph.nodes.map(({ id, resource }) => [resource.address, id])).toEqual([
      ["Deployment/admin", "Deployment/admin"],
      ["Deployment/reports", "Deployment/reports"],
      ["Deployment/booking-api", "db"],
      ["Ingress/web", "edge"],
      ["Deployment/web", "front"],
    ]);
  });

  it("doesn't match by a name two objects or two target nodes share", () => {
    const config = repo({
      "k8s/a.yaml": deployment("web").replace("name: web", "name: web\n  namespace: a"),
      "k8s/b.yaml": deployment("web").replace("name: web", "name: web\n  namespace: b"),
      "k8s/c.yaml": deployment("api"),
    });
    const graph = deriveKubernetes(
      config,
      target({ web: "nginx", api1: { name: "api", technology: "x" }, api2: { name: "API", technology: "y" } }),
    );
    expect(graph.nodes.map(({ id }) => id)).toEqual(["Deployment/a/web", "Deployment/api", "Deployment/b/web"]);
  });

  it("refuses a Helm chart and a missing folder", () => {
    const chart = repo({ "k8s/Chart.yaml": "name: chairside\n" });
    expect(() => deriveKubernetes(chart, target({ x: "" }))).toThrow(
      /^k8s\/ is a Helm chart; render it with `helm template`/,
    );
    const templates = repo({ "k8s/Chart.yaml": "name: chairside\n", "k8s/templates/app.yaml": deployment("x") });
    templates.iac.kubernetes = "k8s/templates";
    expect(() => deriveKubernetes(templates, target({ x: "" }))).toThrow(/k8s\/templates is a Helm chart/);
    const missing = repo({});
    missing.iac.kubernetes = "deploy/";
    expect(() => deriveKubernetes(missing, target({ x: "" }))).toThrow(/^deploy\/ not found; check "iac.kubernetes"/);
  });

  it("covers every mapped kind in the docs table", () => {
    const spec = readFileSync(join(import.meta.dirname, "..", "docs", "product-spec.md"), "utf8");
    for (const key of [...Object.keys(kindMappings), ...supportingKinds]) {
      const kind = key.slice(key.lastIndexOf("/") + 1);
      expect(spec, key).toContain(`\`${kind}\``);
    }
  });
});

describe("asBuiltDeployment from Kubernetes", () => {
  it("compares each workload whatever its technology, and leaves the server, cluster and namespace alone", () => {
    const config = repo({ "k8s/apps.yaml": deployment("booking-api", 3) });
    const model = target({
      server: "Intel NUC",
      cluster: { technology: "k3s", parent: "server" },
      namespace: { technology: "Kubernetes Namespace", parent: "cluster" },
      "booking-api": { technology: "Kubernetes Deployment", parent: "namespace", instances: "2" },
      "booking-api/app": { type: "containerInstance", parent: "booking-api", element: "bookingApi" },
      postgres: { technology: "PostgreSQL 16", parent: "namespace" },
      "postgres/db": { type: "containerInstance", parent: "postgres", element: "database" },
    });
    expect(diffOf(model, config)).toEqual({
      added: [],
      removed: ["postgres", "postgres/db"],
      drifted: [{ id: "booking-api", changes: [{ field: "instances", from: "2", to: "3" }] }],
    });
  });
});

describe("the clinic fixture", () => {
  it("matches the target's Clinic deployment", () => {
    const graph = deriveDeployment(clinic(), clinicTarget())!;
    expect(graph.nodes.map(({ id, resource }) => [id, resource.address])).toEqual([
      ["api", "Deployment/chairside/booking-api"],
      ["db", "StatefulSet/chairside/postgres"],
      ["ingress", "Ingress/chairside/chairside"],
      ["web", "Deployment/chairside/web"],
    ]);
    expect(graph.unknown).toEqual([]);
    expect(deploymentCheck(clinicTarget(), clinic())).toBe(
      "Deployment: passed, the Kubernetes manifests match the target's Clinic deployment\n",
    );
  });

  it("flags a workload the target doesn't have", () => {
    expect(deploymentCheck(clinicTarget(), clinic("redis-cache"))).toBe(
      "Deployment: failed, the Kubernetes manifests don't match the target's Clinic deployment\n" +
        "  Deployment/chairside/redis: Kubernetes Deployment in the Kubernetes manifests, but not in the target (k8s/redis.yaml:1)\n",
    );
  });

  it("flags replicas that differ from the target's instances", () => {
    expect(deploymentCheck(clinicTarget(), clinic("scaled-api"))).toBe(
      "Deployment: failed, the Kubernetes manifests don't match the target's Clinic deployment\n" +
        "  api: instances 2 in the target, 3 in the Kubernetes manifests\n",
    );
  });

  it("flags a target workload with no object", () => {
    const config = clinic();
    writeFileSync(join(config.root, "k8s", "postgres.yaml"), "");
    expect(deploymentCheck(clinicTarget(), config)).toBe(
      "Deployment: failed, the Kubernetes manifests don't match the target's Clinic deployment\n" +
        "  db: PostgreSQL 16 in the target, but no resource in the Kubernetes manifests\n",
    );
  });
});
