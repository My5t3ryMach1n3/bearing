import type { Config } from "./config.js";
import type { Element, Model } from "./model.js";
import {
  deriveTerraform,
  readTerraform,
  terraformProperty,
  type Block,
  type TerraformGraph,
  type TerraformResource,
  type Value,
} from "./terraform.js";

// Relationships through a queue aren't imports: the code that sends and the code that receives never import each
// other. Bearing builds them from the Terraform instead, from the queue and from the IAM policies of the roles each
// deployment node runs as. See "How queues map to relationships" in docs/product-spec.md.

export interface QueueRelationship {
  // "<source>-><destination>", as for imports: "eventPublisher->appointmentEvents" for a sender,
  // "appointmentEvents->eventConsumer" for a receiver.
  id: string;
  source: string;
  destination: string;
  // Whether the source sends to the queue, or the destination receives from it.
  direction: "send" | "receive";
  // Every IAM statement that allows it, in file and line order.
  grants: QueueGrant[];
}

export interface QueueGrant {
  // The deployment node's resource whose role the statement is attached to, e.g. "aws_ecs_service.booking_api".
  node: string;
  // The role, e.g. "aws_iam_role.booking_api_task".
  role: string;
  // The policy's resource or data source, with the file and line of the statement.
  policy: TerraformResource;
  // The statement's actions that allow it, as written, e.g. ["sqs:SendMessage"].
  actions: string[];
}

// The SQS actions that send or receive a message. A statement's action matches them as IAM matches it: ignoring case,
// with `*` and `?` as wildcards.
const sendActions = ["sqs:SendMessage", "sqs:SendMessageBatch"];
const receiveActions = ["sqs:ReceiveMessage"];

const queueType = "aws_sqs_queue";
// Technologies that read as a queue on a target element.
const queueTechnology = /\bsqs\b/i;

// Builds the relationships through each queue in the Terraform. A deployment node's code may send to a queue when
// the role it runs as is allowed `sqs:SendMessage` on it, and may receive from it when allowed `sqs:ReceiveMessage`.
// That's the container the node deploys; the relationship is narrowed to the container's components the target
// declares a relationship with the queue for, and is left on the container when it declares none.
export function deriveQueues(
  config: Config,
  target: Model,
  blocks: Block[] = readTerraform(config),
  graph: TerraformGraph = deriveTerraform(config, target, blocks),
): QueueRelationship[] {
  const resources = new Map(blocks.filter((block) => block.kind !== "module").map((block) => [block.address, block]));
  const queues = blocks.filter((block) => block.kind === "resource" && block.type === queueType);
  const queueIds = queueElements(target, queues);
  const roles = rolePolicies(blocks, resources);

  const relationships = new Map<string, QueueRelationship>();
  const add = (source: string, destination: string, direction: "send" | "receive", grant: QueueGrant) => {
    const id = `${source}->${destination}`;
    let relationship = relationships.get(id);
    if (relationship === undefined) {
      relationship = { id, source, destination, direction, grants: [] };
      relationships.set(id, relationship);
    }
    const seen = relationship.grants.some(
      (other) =>
        other.node === grant.node && other.policy.file === grant.policy.file && other.policy.line === grant.policy.line,
    );
    if (!seen) relationship.grants.push(grant);
  };

  for (const node of graph.nodes) {
    const block = resources.get(node.resource.address);
    const role = block === undefined ? undefined : roleOf(block, resources);
    if (role === undefined) continue;
    const containers = containersOf(target, node.id);
    const sources = containers.length > 0 ? containers : [node.id];
    for (const statement of roles.get(role) ?? []) {
      const sends = statement.actions.filter((action) => sendActions.some((name) => matches(action, name)));
      const receives = statement.actions.filter((action) => receiveActions.some((name) => matches(action, name)));
      if (sends.length === 0 && receives.length === 0) continue;
      for (const queue of queuesIn(statement.resources, queues)) {
        const queueId = queueIds.get(queue.address)!;
        for (const container of sources) {
          const grant = (actions: string[]): QueueGrant => ({
            node: node.resource.address,
            role,
            policy: statement.policy,
            actions,
          });
          if (sends.length > 0) {
            for (const source of declaredEnds(target, container, queueId, "send")) {
              add(source, queueId, "send", grant(sends));
            }
          }
          if (receives.length > 0) {
            for (const destination of declaredEnds(target, container, queueId, "receive")) {
              add(queueId, destination, "receive", grant(receives));
            }
          }
        }
      }
    }
  }

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const relationship of relationships.values()) {
    relationship.grants.sort((a, b) =>
      a.policy.file < b.policy.file
        ? -1
        : a.policy.file > b.policy.file
          ? 1
          : a.policy.line - b.policy.line || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0),
    );
  }
  return [...relationships.values()].sort(byId);
}

// The target element each queue stands for: the one whose `bearing.terraform` property names it, or failing that the
// one queue element left when there's one queue left. A queue that matches nothing keeps its address.
export function queueElements(target: Model, queues: Block[]): Map<string, string> {
  const ids = new Map<string, string>();
  const elements = [...target.elements.values()].filter(
    (element) => element.type === "container" || element.type === "softwareSystem",
  );
  const taken = new Set<string>();
  for (const queue of queues) {
    const pinned = elements.find((element) => element.properties[terraformProperty] === queue.address);
    if (pinned !== undefined && !taken.has(pinned.id)) {
      ids.set(queue.address, pinned.id);
      taken.add(pinned.id);
    }
  }
  const unpinned = queues.filter((queue) => !ids.has(queue.address));
  const candidates = elements.filter(
    (element) =>
      !taken.has(element.id) &&
      element.properties[terraformProperty] === undefined &&
      queueTechnology.test(element.technology),
  );
  if (unpinned.length === 1 && candidates.length === 1) ids.set(unpinned[0]!.address, candidates[0]!.id);
  for (const queue of queues) if (!ids.has(queue.address)) ids.set(queue.address, queue.address);
  return ids;
}

// The target's queues: the elements a queue in the Terraform stands for, and any container or software system of an
// SQS technology or whose `bearing.terraform` names a queue.
export function queueTargets(target: Model): Set<string> {
  return new Set(
    [...target.elements.values()]
      .filter(
        (element) =>
          (element.type === "container" || element.type === "softwareSystem") &&
          (queueTechnology.test(element.technology) ||
            element.properties[terraformProperty]?.startsWith(`${queueType}.`) === true),
      )
      .map((element) => element.id),
  );
}

// The element each queue's literal `name` in the Terraform stands for, which is how the trace hooks name a queue.
export function queueNames(target: Model, blocks: Block[]): Map<string, string> {
  const queues = blocks.filter((block) => block.kind === "resource" && block.type === queueType);
  const ids = queueElements(target, queues);
  const names = new Map<string, string>();
  for (const queue of queues) {
    const name = queue.attributes.get("name");
    if (name !== undefined && target.elements.has(ids.get(queue.address)!)) names.set(name, ids.get(queue.address)!);
  }
  return names;
}

// The containers deployed in a target deployment node, at any depth.
function containersOf(target: Model, node: string): string[] {
  const within = (id: string | undefined): boolean => {
    for (let at = id; at !== undefined; at = target.deployment.get(at)?.parent) if (at === node) return true;
    return false;
  };
  const containers = new Set<string>();
  for (const element of target.deployment.values()) {
    if (element.type !== "containerInstance" || element.element === undefined || !within(element.parent)) continue;
    if (target.elements.get(element.element)?.type === "container") containers.add(element.element);
  }
  return [...containers].sort();
}

// The ends a grant to `container` stands for: the container's components the target declares the relationship with
// the queue for, or the container itself if it declares it on none of them.
function declaredEnds(target: Model, container: string, queue: string, direction: "send" | "receive"): string[] {
  const inContainer = (id: string) => {
    const element: Element | undefined = target.elements.get(id);
    return element?.type === "component" && element.parent === container;
  };
  const ends = new Set<string>();
  for (const relationship of target.relationships.values()) {
    const [end, other] =
      direction === "send"
        ? [relationship.source, relationship.destination]
        : [relationship.destination, relationship.source];
    if (other === queue && inContainer(end)) ends.add(end);
  }
  return ends.size > 0 ? [...ends].sort() : [container];
}

// The role a deployment node's code runs as: an ECS service's task definition's task role, or a Lambda function's
// execution role.
function roleOf(block: Block, resources: Map<string, Block>): string | undefined {
  if (block.type === "aws_ecs_service") {
    const definition = references(block.body.attributes.get("task_definition"), "aws_ecs_task_definition")[0];
    const task = definition === undefined ? undefined : resources.get(definition);
    return task === undefined ? undefined : roleReference(task.body.attributes.get("task_role_arn"), resources);
  }
  if (block.type === "aws_lambda_function") return roleReference(block.body.attributes.get("role"), resources);
  return undefined;
}

// The role a value names, by reference or by its literal name or ARN.
function roleReference(value: Value | undefined, resources: Map<string, Block>): string | undefined {
  const reference = references(value, "aws_iam_role")[0];
  if (reference !== undefined) return resources.has(reference) ? reference : undefined;
  const text = value?.kind === "string" ? value.value : undefined;
  if (text === undefined) return undefined;
  const name = text.startsWith("arn:") ? text.split("/").at(-1) : text;
  for (const block of resources.values()) {
    if (block.kind === "resource" && block.type === "aws_iam_role" && block.attributes.get("name") === name) {
      return block.address;
    }
  }
  return undefined;
}

interface Statement {
  actions: string[];
  // As written: references such as "aws_sqs_queue.events.arn", interpolated text and literal ARNs.
  resources: string[];
  policy: TerraformResource;
}

// Each role's Allow statements, from its inline policies, `aws_iam_role_policy` resources and attached
// `aws_iam_policy` resources.
function rolePolicies(blocks: Block[], resources: Map<string, Block>): Map<string, Statement[]> {
  const byRole = new Map<string, Statement[]>();
  const attach = (role: string | undefined, statements: Statement[]) => {
    if (role === undefined || statements.length === 0) return;
    byRole.set(role, [...(byRole.get(role) ?? []), ...statements]);
  };
  const managed = (value: Value | undefined) =>
    references(value, "aws_iam_policy").flatMap((address) => {
      const policy = resources.get(address);
      return policy === undefined ? [] : policyStatements(policy.body.attributes.get("policy"), policy, resources);
    });

  for (const block of blocks) {
    if (block.kind !== "resource") continue;
    const attributes = block.body.attributes;
    switch (block.type) {
      case "aws_iam_role":
        for (const inline of block.body.blocks.filter((nested) => nested.type === "inline_policy")) {
          attach(block.address, policyStatements(inline.body.attributes.get("policy"), block, resources, inline.line));
        }
        attach(block.address, managed(attributes.get("managed_policy_arns")));
        break;
      case "aws_iam_role_policy":
        attach(
          roleReference(attributes.get("role"), resources),
          policyStatements(attributes.get("policy"), block, resources),
        );
        break;
      case "aws_iam_role_policy_attachment":
        attach(roleReference(attributes.get("role"), resources), managed(attributes.get("policy_arn")));
        break;
      case "aws_iam_policy_attachment":
        for (const role of listOf(attributes.get("roles"))) {
          attach(roleReference(role, resources), managed(attributes.get("policy_arn")));
        }
        break;
    }
  }
  return byRole;
}

// The Allow statements of a policy document: `jsonencode(...)`, a JSON string or heredoc, or an
// `aws_iam_policy_document` data source's `json`. Deny statements, and statements with `NotAction` or `NotResource`,
// are left out.
function policyStatements(
  value: Value | undefined,
  owner: Block,
  resources: Map<string, Block>,
  line = owner.line,
  seen = new Set<string>(),
): Statement[] {
  if (value === undefined) return [];
  const at = (statementLine: number): TerraformResource => ({
    address: owner.address,
    file: owner.file,
    line: statementLine,
  });
  if (value.kind === "call" && value.name === "jsonencode" && value.args[0] !== undefined) {
    return fromDocument(toJson(value.args[0]), (object) => at(lineOf(object) ?? line));
  }
  if (value.kind === "string" || value.kind === "template") {
    // An interpolation in a JSON policy reads as the expression it holds, such as "aws_sqs_queue.events.arn".
    const text = value.kind === "string" ? value.value : value.text.replace(/\$\{\s*([^}]*?)\s*\}/g, "$1");
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      return [];
    }
    return fromDocument(document, () => at(value.kind === "template" ? value.line : line));
  }
  const documents = references(value, "data.aws_iam_policy_document");
  return documents.flatMap((address) => {
    const document = resources.get(address);
    if (document === undefined || seen.has(address)) return [];
    seen.add(address);
    return documentStatements(document, resources, seen);
  });
}

// The Allow statements of an `aws_iam_policy_document` data source, with those of the documents it builds on.
function documentStatements(document: Block, resources: Map<string, Block>, seen: Set<string>): Statement[] {
  const statements: Statement[] = [];
  for (const key of ["source_policy_documents", "override_policy_documents"]) {
    for (const source of listOf(document.body.attributes.get(key))) {
      statements.push(...policyStatements(source, document, resources, document.line, seen));
    }
  }
  for (const block of document.body.blocks.filter((nested) => nested.type === "statement")) {
    const attributes = block.body.attributes;
    const effect = attributes.get("effect");
    if (effect?.kind === "string" && effect.value.toLowerCase() === "deny") continue;
    if (attributes.has("not_actions") || attributes.has("not_resources")) continue;
    statements.push({
      actions: strings(attributes.get("actions")),
      resources: strings(attributes.get("resources")),
      policy: { address: document.address, file: document.file, line: block.line },
    });
  }
  return statements;
}

// The Allow statements of a policy document read as JSON. Keys are matched ignoring case.
function fromDocument(document: unknown, at: (statement: object) => TerraformResource): Statement[] {
  const get = (object: unknown, key: string): unknown => {
    if (typeof object !== "object" || object === null || Array.isArray(object)) return undefined;
    const found = Object.keys(object).find((name) => name.toLowerCase() === key.toLowerCase());
    return found === undefined ? undefined : (object as Record<string, unknown>)[found];
  };
  const list = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
  const statements: Statement[] = [];
  for (const statement of list(get(document, "Statement"))) {
    if (typeof statement !== "object" || statement === null) continue;
    const effect = get(statement, "Effect");
    if (typeof effect === "string" && effect.toLowerCase() === "deny") continue;
    if (get(statement, "NotAction") !== undefined || get(statement, "NotResource") !== undefined) continue;
    const text = (value: unknown) => list(value).filter((item): item is string => typeof item === "string");
    statements.push({
      actions: text(get(statement, "Action")),
      resources: text(get(statement, "Resource")),
      policy: at(statement),
    });
  }
  return statements;
}

// Lines of the objects `toJson` makes, for the statement's line.
const lines = new WeakMap<object, number>();
const lineOf = (object: object) => lines.get(object);

// An HCL value as the JSON `jsonencode` would make of it. A reference becomes its text, as an interpolation would in
// a JSON string; an expression becomes a list of its parts.
function toJson(value: Value): unknown {
  switch (value.kind) {
    case "string":
      return value.value;
    case "template":
      return value.text.replace(/\$\{\s*([^}]*?)\s*\}/g, "$1");
    case "word":
      return /^-?\d+(\.\d+)?$/.test(value.value)
        ? Number(value.value)
        : value.value === "true" || value.value === "false"
          ? value.value === "true"
          : value.value;
    case "tuple":
      return value.items.map(toJson);
    case "object": {
      const object = Object.fromEntries(value.entries.map(({ key, value: entry }) => [key, toJson(entry)]));
      lines.set(object, value.line);
      return object;
    }
    case "call":
      return value.args.map(toJson);
    case "expression":
      return value.parts.map(toJson);
  }
}

// The strings, references and interpolated text in a value, flattened.
function strings(value: Value | undefined): string[] {
  const flat = (item: unknown): string[] =>
    typeof item === "string" ? [item] : Array.isArray(item) ? item.flatMap(flat) : [];
  return value === undefined ? [] : flat(toJson(value));
}

function listOf(value: Value | undefined): Value[] {
  if (value === undefined) return [];
  return value.kind === "tuple" ? value.items : [value];
}

// The addresses of blocks of `type` that a value refers to, e.g. "aws_iam_role.api" for `aws_iam_role.api.arn` or
// "data.aws_iam_policy_document.send" for its `.json`. Interpolations count.
function references(value: Value | undefined, type: string): string[] {
  const pattern = new RegExp(`(?:^|[^\\w.])(${type.replaceAll(".", "\\.")}\\.[\\w-]+)`, "g");
  const found = new Set<string>();
  for (const text of strings(value)) for (const match of ` ${text}`.matchAll(pattern)) found.add(match[1]!);
  return [...found];
}

// The queues a statement's resources name: by reference, by an ARN whose name matches a queue's literal `name`
// (wildcards included), or every queue for "*".
function queuesIn(resources: string[], queues: Block[]): Block[] {
  const found = new Set<Block>();
  for (const resource of resources) {
    const named = [...` ${resource}`.matchAll(/(?:^|[^\w.])(aws_sqs_queue\.[\w-]+)/g)].map((match) => match[1]!);
    if (named.length > 0) {
      for (const queue of queues) if (named.includes(queue.address)) found.add(queue);
      continue;
    }
    if (resource === "*") {
      for (const queue of queues) found.add(queue);
      continue;
    }
    const arn = resource.split(":");
    if (arn[0] !== "arn" || arn.length < 6 || !matches("sqs", arn[2]!)) continue;
    const name = arn.slice(5).join(":");
    for (const queue of queues) {
      const literal = queue.attributes.get("name");
      if (literal !== undefined && matches(name, literal, false)) found.add(queue);
    }
  }
  return queues.filter((queue) => found.has(queue));
}

// Whether `name` matches an IAM pattern with `*` and `?` wildcards.
function matches(pattern: string, name: string, ignoreCase = true): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, ignoreCase ? "i" : "").test(name);
}
