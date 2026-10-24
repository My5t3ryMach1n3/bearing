import type { Workspace } from "./structurizr.js";

// The one in-memory model that the target, the as-built model and claims all share. Everything is keyed by a
// stable ID rather than Structurizr's numeric IDs, which are renumbered whenever an element is added or moved.
export interface Model {
  elements: Map<string, Element>;
  relationships: Map<string, Relationship>;
  dynamicViews: Map<string, DynamicView>;
  deployment: Map<string, DeploymentElement>;
}

export type ElementType = "person" | "softwareSystem" | "container" | "component";

export interface Element {
  id: string;
  type: ElementType;
  name: string;
  description: string;
  technology: string;
  // User tags only; Structurizr's built-in ones (Element, Component, ...) are dropped.
  tags: string[];
  // Stable ID of the enclosing software system or container.
  parent?: string;
  // `bearing.path`: the folder a component owns.
  path?: string;
  // `bearing.requirements`: the issues an element serves, e.g. ["#1", "#2"].
  requirements: string[];
  // Any other properties, except Structurizr's own and the two above.
  properties: Record<string, string>;
}

export interface Relationship {
  id: string;
  source: string;
  destination: string;
  description: string;
  technology: string;
  tags: string[];
  properties: Record<string, string>;
}

export interface DynamicView {
  // The view's key, e.g. "req-2".
  id: string;
  // Stable ID of the software system or container the view is scoped to, if any.
  scope?: string;
  description: string;
  steps: DynamicStep[];
}

export interface DynamicStep {
  order: string;
  source: string;
  destination: string;
  description: string;
}

export type DeploymentType = "deploymentNode" | "infrastructureNode" | "containerInstance" | "softwareSystemInstance";

export interface DeploymentElement {
  id: string;
  type: DeploymentType;
  environment: string;
  name: string;
  description: string;
  technology: string;
  tags: string[];
  // Stable ID of the enclosing deployment node.
  parent?: string;
  // How many instances a deployment node stands for, e.g. "2" or "1..N".
  instances?: string;
  // Stable ID of the container or software system an instance deploys.
  element?: string;
  properties: Record<string, string>;
}

// The parts of Structurizr's workspace JSON the model reads.
interface JsonItem {
  id: string;
  name?: string;
  description?: string;
  technology?: string;
  tags?: string;
  properties?: Record<string, string>;
  relationships?: JsonRelationship[];
}

interface JsonRelationship extends JsonItem {
  sourceId: string;
  destinationId: string;
  // Set on relationships Structurizr implies from another one, e.g. container to container from component to
  // component, and on the copies it makes between deployment instances.
  linkedRelationshipId?: string;
}

interface JsonElement extends JsonItem {
  name: string;
  containers?: JsonElement[];
  components?: JsonElement[];
}

interface JsonDeploymentNode extends JsonItem {
  name: string;
  environment: string;
  instances?: string | number;
  children?: JsonDeploymentNode[];
  infrastructureNodes?: Array<JsonItem & { environment: string }>;
  containerInstances?: Array<JsonItem & { environment: string; containerId: string }>;
  softwareSystemInstances?: Array<JsonItem & { environment: string; softwareSystemId: string }>;
}

interface JsonWorkspace {
  model?: {
    people?: JsonElement[];
    softwareSystems?: JsonElement[];
    deploymentNodes?: JsonDeploymentNode[];
  };
  views?: {
    dynamicViews?: Array<{
      key: string;
      elementId?: string;
      description?: string;
      relationships?: Array<{ id: string; order?: string; description?: string }>;
    }>;
  };
}

const builtInTags = new Set([
  "Element",
  "Person",
  "Software System",
  "Container",
  "Component",
  "Deployment Node",
  "Infrastructure Node",
  "Container Instance",
  "Software System Instance",
  "Relationship",
]);

const identifierProperty = "structurizr.dsl.identifier";
// Structurizr names elements the DSL left anonymous with a random UUID, which changes on every export.
const generatedIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Builds the model from workspace JSON as Structurizr exports it.
//
// Stable IDs:
// - An element or deployment node uses its DSL identifier, so editing its name or description reads as drift,
//   not as a removal. An anonymous one falls back to its parent's ID and its name, e.g. "basketApi/Basket service".
// - A relationship is "<source>-><destination>", since extracted as-built relationships never carry a DSL
//   identifier. When one pair has several relationships, each gets its description too: "a->b[save()]".
// - A dynamic view uses its key; an instance uses its deployment node's ID and what it deploys: "ecs/basketApi".
export function modelFromWorkspace(workspace: Workspace): Model {
  const json = workspace as JsonWorkspace;
  const model: Model = {
    elements: new Map(),
    relationships: new Map(),
    dynamicViews: new Map(),
    deployment: new Map(),
  };
  // Structurizr's numeric ID to stable ID, for elements, deployment elements and relationships.
  const ids = new Map<string, string>();
  const relationships: JsonRelationship[] = [];
  const collect = (item: JsonItem) => relationships.push(...(item.relationships ?? []));

  const addElement = (item: JsonElement, type: ElementType, parent?: string) => {
    const id = stableId(item, parent === undefined ? item.name : `${parent}/${item.name}`);
    const { "bearing.path": path, "bearing.requirements": requirements, ...properties } = ownProperties(item);
    const element: Element = { id, type, ...describe(item), requirements: splitList(requirements), properties };
    if (parent !== undefined) element.parent = parent;
    if (path !== undefined) element.path = path;
    add(model.elements, element, ids, item.id);
    collect(item);
    for (const container of item.containers ?? []) addElement(container, "container", element.id);
    for (const component of item.components ?? []) addElement(component, "component", element.id);
  };
  for (const person of json.model?.people ?? []) addElement(person, "person");
  for (const system of json.model?.softwareSystems ?? []) addElement(system, "softwareSystem");

  // Instances refer to elements, so deployment is read once every element has its stable ID.
  const addDeployment = (item: JsonItem & { environment: string }, type: DeploymentType, fallback: string) => {
    const id = stableId(item, fallback);
    const deployment: DeploymentElement = {
      id,
      type,
      ...describe(item),
      environment: item.environment,
      properties: ownProperties(item),
    };
    add(model.deployment, deployment, ids, item.id);
    collect(item);
    return deployment;
  };
  const addNode = (node: JsonDeploymentNode, parent?: string) => {
    const deployment = addDeployment(node, "deploymentNode", `${parent ?? node.environment}/${node.name}`);
    if (parent !== undefined) deployment.parent = parent;
    if (node.instances !== undefined) deployment.instances = String(node.instances);
    const children = [
      ...(node.infrastructureNodes ?? []).map((item) => ({ item, type: "infrastructureNode" as const, of: undefined })),
      ...(node.containerInstances ?? []).map((item) => ({
        item,
        type: "containerInstance" as const,
        of: item.containerId,
      })),
      ...(node.softwareSystemInstances ?? []).map((item) => ({
        item,
        type: "softwareSystemInstance" as const,
        of: item.softwareSystemId,
      })),
    ];
    for (const { item, type, of } of children) {
      // Instances have no name of their own, so they are named after what they deploy.
      const element = of === undefined ? undefined : ids.get(of);
      const child = addDeployment(item, type, `${deployment.id}/${element ?? item.name ?? item.id}`);
      child.parent = deployment.id;
      if (element !== undefined) {
        child.name = model.elements.get(element)?.name ?? "";
        child.element = element;
      }
    }
    for (const child of node.children ?? []) addNode(child, deployment.id);
  };
  for (const node of json.model?.deploymentNodes ?? []) addNode(node);

  const stable = (jsonId: string) => ids.get(jsonId) ?? jsonId;
  const explicit = relationships.filter((relationship) => relationship.linkedRelationshipId === undefined);
  const pairOf = (relationship: JsonRelationship) =>
    `${stable(relationship.sourceId)}->${stable(relationship.destinationId)}`;
  const pairs = new Map<string, number>();
  for (const relationship of explicit) pairs.set(pairOf(relationship), (pairs.get(pairOf(relationship)) ?? 0) + 1);
  for (const relationship of explicit) {
    const pair = pairOf(relationship);
    const { description, technology, tags } = describe(relationship);
    const relationshipModel: Relationship = {
      id: pairs.get(pair)! > 1 ? `${pair}[${description}]` : pair,
      source: stable(relationship.sourceId),
      destination: stable(relationship.destinationId),
      description,
      technology,
      tags,
      properties: ownProperties(relationship),
    };
    add(model.relationships, relationshipModel, ids, relationship.id);
  }

  // A dynamic view step can name an implied relationship, so steps are resolved against all of them.
  const byId = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  for (const view of json.views?.dynamicViews ?? []) {
    const steps = (view.relationships ?? []).flatMap((step): DynamicStep[] => {
      const relationship = byId.get(step.id);
      if (relationship === undefined) return [];
      return [
        {
          order: step.order ?? "",
          source: stable(relationship.sourceId),
          destination: stable(relationship.destinationId),
          description: step.description ?? relationship.description ?? "",
        },
      ];
    });
    steps.sort((a, b) => a.order.localeCompare(b.order, undefined, { numeric: true }));
    const dynamicView: DynamicView = { id: view.key, description: view.description ?? "", steps };
    if (view.elementId !== undefined) dynamicView.scope = stable(view.elementId);
    model.dynamicViews.set(dynamicView.id, dynamicView);
  }
  return model;
}

function stableId(item: JsonItem, fallback: string): string {
  const identifier = item.properties?.[identifierProperty];
  return identifier !== undefined && !generatedIdentifier.test(identifier) ? identifier : fallback;
}

// Adds an item under its stable ID. Two anonymous siblings with the same name would collide, so later ones are
// numbered: "basketApi/Worker#2".
function add<T extends { id: string }>(map: Map<string, T>, item: T, ids: Map<string, string>, jsonId: string) {
  let id = item.id;
  for (let n = 2; map.has(id); n++) id = `${item.id}#${n}`;
  item.id = id;
  map.set(id, item);
  ids.set(jsonId, id);
}

function describe(item: JsonItem) {
  return {
    name: item.name ?? "",
    description: item.description ?? "",
    technology: item.technology ?? "",
    tags: splitList(item.tags).filter((tag) => !builtInTags.has(tag)),
  };
}

// Properties other than Structurizr's own, such as its DSL identifier.
function ownProperties(item: JsonItem): Record<string, string> {
  return Object.fromEntries(Object.entries(item.properties ?? {}).filter(([key]) => !key.startsWith("structurizr.")));
}

function splitList(text: string | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
