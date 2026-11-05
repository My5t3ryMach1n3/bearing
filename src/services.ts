import type { DeploymentGraph } from "./deployment.js";
import { kindMappings, stringMap, type Manifest } from "./kubernetes.js";
import type { Model } from "./model.js";
import { containersOf } from "./queues.js";

// Services in one cluster call each other over HTTP by their Kubernetes Service's name, e.g.
// `http://booking-api:8000/slots`. The trace hooks record each request's host, and the manifests say which container
// a Service's name reaches: the Service's selector picks the workloads whose pods carry its labels, each workload is
// the deployment node it matched, and the node runs the container. See "Traces across HTTP" in docs/product-spec.md.

export interface ServiceRoute {
  // The Service's address, e.g. "Service/chairside/booking-api".
  address: string;
  name: string;
  namespace?: string;
  // The ports the Service exposes. A request on another port doesn't reach it.
  ports: number[];
  // The target container its workloads run.
  container: string;
}

// The Services in the manifests whose workloads run exactly one target container, by the container they reach. A
// Service with no selector, one whose workloads match no target node, or one whose nodes run several containers or
// none reaches nothing Bearing can name, so it's left out.
export function serviceRoutes(target: Model, manifests: Manifest[], graph: DeploymentGraph): ServiceRoute[] {
  const nodes = new Map(graph.nodes.map((node) => [node.resource.address, node.id]));
  const workloads = manifests.filter((manifest) => kindMappings[keyOf(manifest)]?.type === "deploymentNode");
  const routes: ServiceRoute[] = [];
  for (const service of manifests.filter((manifest) => keyOf(manifest) === "Service")) {
    const selector = stringMap(service.spec.selector);
    if (Object.keys(selector).length === 0) continue;
    const containers = new Set<string>();
    for (const workload of workloads) {
      if (workload.namespace !== service.namespace) continue;
      const labels = podLabels(workload);
      if (!Object.entries(selector).every(([key, value]) => labels[key] === value)) continue;
      const node = nodes.get(workload.address);
      // A workload the target has no node for is one Bearing can't name.
      if (node === undefined || !target.deployment.has(node)) continue;
      for (const container of containersOf(target, node)) containers.add(container);
    }
    if (containers.size !== 1) continue;
    const ports = Array.isArray(service.spec.ports)
      ? service.spec.ports.flatMap((port: unknown) => {
          const number = (port as { port?: unknown } | null)?.port;
          return typeof number === "number" ? [number] : [];
        })
      : [];
    routes.push({
      address: service.address,
      name: service.name,
      ...(service.namespace === undefined ? {} : { namespace: service.namespace }),
      ports,
      container: [...containers][0]!,
    });
  }
  return routes;
}

// The Service a request's host and port reach, as cluster DNS resolves it: `<name>`, `<name>.<namespace>`,
// `<name>.<namespace>.svc` or `<name>.<namespace>.svc.cluster.local`. A Service with no namespace in its manifest is
// reached in whichever namespace it's applied to. With no port, or one the Service exposes. A host two Services could
// answer, such as a short name used in two namespaces, reaches neither.
export function routeFor(routes: ServiceRoute[], host: string, port?: number): ServiceRoute | undefined {
  const [name, ...rest] = host.toLowerCase().replace(/\.$/, "").split(".");
  const namespace = rest[0];
  const suffix = rest.slice(1).join(".");
  if (suffix !== "" && suffix !== "svc" && suffix !== "svc.cluster.local") return undefined;
  const found = routes.filter(
    (route) =>
      route.name === name &&
      (namespace === undefined || route.namespace === undefined || route.namespace === namespace) &&
      (port === undefined || route.ports.length === 0 || route.ports.includes(port)),
  );
  return found.length === 1 ? found[0] : undefined;
}

const keyOf = (manifest: Manifest) => (manifest.group === "" ? manifest.kind : `${manifest.group}/${manifest.kind}`);

// The labels a workload's pods carry: a Pod's own, a CronJob's job template's, or any other workload's pod template's.
function podLabels(workload: Manifest): Record<string, string> {
  if (workload.kind === "Pod") return workload.labels;
  const at = (value: unknown, ...path: string[]): unknown =>
    path.reduce<unknown>(
      (object, key) =>
        typeof object === "object" && object !== null ? (object as Record<string, unknown>)[key] : undefined,
      value,
    );
  const template =
    workload.kind === "CronJob" ? at(workload.spec, "jobTemplate", "spec", "template") : at(workload.spec, "template");
  return stringMap(at(template, "metadata", "labels"));
}
