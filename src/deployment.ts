import type { DeploymentElement, DeploymentType, Model } from "./model.js";

// The infrastructure as code `bearing derive` reads deployment nodes from: `iac.terraform` or `iac.kubernetes`.
export type IacSource = "terraform" | "kubernetes";

// What the IaC gives. This is the `deployment` section `bearing derive` prints.
export interface DeploymentGraph {
  // The target's deployment environment the IaC is compared with.
  environment: string;
  // Older reports have none, as they only read Terraform.
  source?: IacSource;
  // One per resource that stands for a deployment node. Sorted by ID.
  nodes: DeploymentGraphNode[];
  // Resources of types Bearing doesn't map, and modules it doesn't follow. Sorted by address.
  unknown: IacResource[];
}

export interface DeploymentGraphNode {
  // The target deployment node's ID when the resource matches one, otherwise the resource's address.
  id: string;
  type: DeploymentType;
  // What the resource deploys, e.g. "Amazon ElastiCache" or "Kubernetes Deployment".
  technology: string;
  // From the resource's count, e.g. `desired_count` on an ECS service, when it is a plain number.
  instances?: string;
  resource: IacResource;
}

export interface IacResource {
  // As the IaC names it: "aws_ecs_service.basket_api" or "module.network" in Terraform, "Deployment/booking-api" or
  // "Deployment/chairside/booking-api" in Kubernetes.
  address: string;
  // Repo-relative, with forward slashes.
  file: string;
  line: number;
}

// A kind of resource that stands for a deployment node.
export interface NodeMapping {
  type: DeploymentType;
  technology: string;
  // What a target deployment node's technology must match to be this kind of node.
  matches: RegExp;
}

// A resource read as a node, with the mapping that made it one.
export interface FoundNode {
  node: DeploymentGraphNode;
  mapping: NodeMapping;
  // The name a target node of the same type can match it by, e.g. a Kubernetes object's `metadata.name`.
  name?: string;
}

// How a source's nodes are matched with the target's.
export interface SourceRules {
  source: IacSource;
  // The config key, e.g. "iac.kubernetes".
  key: string;
  // The property a target node names its resource with, e.g. "bearing.terraform".
  property: string;
  // Every mapping a target node's technology is checked against.
  mappings: NodeMapping[];
  // Whether a target node holding instances and no other node is compared whatever its technology, as each
  // Kubernetes workload is.
  workloads: boolean;
}

// What each source is called in check output, and whether that takes a plural verb.
export const sourceNames: Record<IacSource, { name: string; plural: boolean }> = {
  terraform: { name: "the Terraform", plural: false },
  kubernetes: { name: "the Kubernetes manifests", plural: true },
};

export class IacError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IacError";
  }
}

// IaC has no environments of its own, so the target must have just one to compare it with.
export function environmentOf(target: Model, key: string): string {
  const environments = [...new Set([...target.deployment.values()].map((element) => element.environment))].sort();
  if (environments.length === 1) return environments[0]!;
  if (environments.length === 0) {
    throw new IacError(`the target has no deployment view to compare "${key}" with`);
  }
  throw new IacError(
    `the target has ${environments.length} deployment environments (${environments.join(", ")}); comparing "${key}" with more than one isn't supported yet`,
  );
}

// "Booking API" and "booking-api" are the same name.
const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

// Matches the nodes found in the IaC with the target's deployment nodes in its one environment, giving each matched
// node the target's ID. A resource matches the target node whose pin property names its address; failing that, the
// one target node of its type with the same name, when the name is unique on both sides; failing that, by technology,
// where a kind of node has exactly one resource and one target node left. A node that matches nothing keeps its
// address as its ID, so it reads as an added node.
export function matchNodes(
  target: Model,
  rules: SourceRules,
  found: FoundNode[],
  unknown: IacResource[],
): DeploymentGraph {
  const environment = environmentOf(target, rules.key);
  const candidates = [...target.deployment.values()].filter(
    (element) =>
      element.environment === environment &&
      (element.type === "deploymentNode" || element.type === "infrastructureNode"),
  );
  const taken = new Set<string>();
  const take = (entry: FoundNode, candidate: DeploymentElement) => {
    entry.node.id = candidate.id;
    taken.add(candidate.id);
  };
  const free = (candidate: DeploymentElement) =>
    !taken.has(candidate.id) && candidate.properties[rules.property] === undefined;

  for (const entry of found) {
    const pin = candidates.find((candidate) => candidate.properties[rules.property] === entry.node.resource.address);
    if (pin !== undefined && !taken.has(pin.id)) take(entry, pin);
  }

  const left = () => found.filter(({ node }) => node.id === node.resource.address);
  const named = (entry: FoundNode) => (entry.name === undefined ? undefined : normalize(entry.name));
  for (const entry of left()) {
    const name = named(entry);
    if (name === undefined) continue;
    const same = (other: FoundNode) => other.node.type === entry.node.type && named(other) === name;
    const nodes = candidates.filter(
      (candidate) => free(candidate) && candidate.type === entry.node.type && normalize(candidate.name) === name,
    );
    if (left().filter(same).length === 1 && nodes.length === 1) take(entry, nodes[0]!);
  }

  const unmatched = left();
  for (const technology of new Set(unmatched.map(({ node }) => node.technology))) {
    const resources = unmatched.filter(({ node }) => node.technology === technology);
    const nodes = candidates.filter(
      (candidate) => free(candidate) && resources[0]!.mapping.matches.test(candidate.technology),
    );
    if (resources.length === 1 && nodes.length === 1) take(resources[0]!, nodes[0]!);
  }

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    environment,
    source: rules.source,
    nodes: found.map(({ node }) => node).sort(byId),
    unknown: [...unknown].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)),
  };
}

// The as-built model the IaC gives, for diffing with the target. Nodes the IaC can't speak to are copied from the
// target so they don't read as removed: other environments, nodes it doesn't compare (such as a region or a cluster
// grouping the rest), and the instances inside nodes that are still there. A compared target node with no resource
// is left out, so it reads as removed. A node is compared when its pin property is set, when its technology is one
// the source maps, or, for a source of workloads, when it holds instances and no other node.
export function deploymentModel(target: Model, graph: DeploymentGraph, rules: SourceRules): Model {
  const model: Model = {
    elements: new Map(),
    relationships: new Map(),
    dynamicViews: new Map(),
    deployment: new Map(),
  };
  const isInstance = (element: DeploymentElement) =>
    element.type === "containerInstance" || element.type === "softwareSystemInstance";
  const children = (element: DeploymentElement) =>
    [...target.deployment.values()].filter((child) => child.parent === element.id);
  const workload = (element: DeploymentElement) => {
    const inside = children(element);
    return inside.length > 0 && inside.every(isInstance);
  };
  const checked = (element: DeploymentElement) =>
    element.environment === graph.environment &&
    (element.type === "deploymentNode" || element.type === "infrastructureNode") &&
    (element.properties[rules.property] !== undefined ||
      rules.mappings.some((mapping) => mapping.matches.test(element.technology)) ||
      (rules.workloads && workload(element)));
  for (const element of target.deployment.values()) {
    if (!checked(element) && !isInstance(element)) model.deployment.set(element.id, element);
  }
  for (const node of graph.nodes) {
    const matched = target.deployment.get(node.id);
    const element: DeploymentElement = matched
      ? { ...matched }
      : {
          id: node.id,
          type: node.type,
          environment: graph.environment,
          name: node.resource.address,
          description: "",
          technology: node.technology,
          tags: [],
          properties: {},
        };
    // Only a plain count is compared; a range such as "1..N" is the target's to state.
    if (node.instances !== undefined && (matched?.instances === undefined || /^\d+$/.test(matched.instances))) {
      element.instances = node.instances;
    }
    model.deployment.set(element.id, element);
  }
  for (const element of target.deployment.values()) {
    if (isInstance(element) && element.parent !== undefined && model.deployment.has(element.parent)) {
      model.deployment.set(element.id, element);
    }
  }
  return model;
}
