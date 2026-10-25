import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import type { Config } from "./config.js";
import type { DeploymentElement, DeploymentType, Model } from "./model.js";

// What the Terraform extractor finds under `iac.terraform`. This is the `deployment` section `bearing derive` prints.
export interface TerraformGraph {
  // The target's deployment environment the Terraform is compared with.
  environment: string;
  // One per resource that stands for a deployment node. Sorted by ID.
  nodes: TerraformNode[];
  // Resources of types Bearing doesn't map, and modules it doesn't follow. Sorted by address.
  unknown: TerraformResource[];
}

export interface TerraformNode {
  // The target deployment node's ID when the resource matches one, otherwise the resource's address.
  id: string;
  type: DeploymentType;
  // The AWS service, e.g. "Amazon ElastiCache".
  technology: string;
  // From the resource's count attribute, e.g. `desired_count` on an ECS service, when it is a plain number.
  instances?: string;
  resource: TerraformResource;
}

export interface TerraformResource {
  // As Terraform writes it, e.g. "aws_ecs_service.basket_api" or "module.network".
  address: string;
  // Repo-relative, with forward slashes.
  file: string;
  line: number;
}

export class TerraformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerraformError";
  }
}

interface Mapping {
  type: DeploymentType;
  technology: string;
  // What a target deployment node's technology must match to be this kind of node.
  matches: RegExp;
  // The attribute holding how many instances the node runs.
  instances?: string;
}

const cloudFront = { type: "infrastructureNode", technology: "Amazon CloudFront", matches: /cloudfront/i } as const;
const loadBalancer = {
  type: "infrastructureNode",
  technology: "Elastic Load Balancing",
  matches: /load balanc|\b[ang]lb\b|\belb\b/i,
} as const;
const apiGateway = { type: "infrastructureNode", technology: "Amazon API Gateway", matches: /api gateway/i } as const;
const rds = { type: "deploymentNode", technology: "Amazon RDS", matches: /\brds\b|aurora/i } as const;

// The AWS resource types that stand for a deployment node. Keep in step with the table in docs/product-spec.md.
export const resourceMappings: Record<string, Mapping> = {
  aws_cloudfront_distribution: cloudFront,
  aws_lb: loadBalancer,
  aws_alb: loadBalancer,
  aws_api_gateway_rest_api: apiGateway,
  aws_apigatewayv2_api: apiGateway,
  aws_sqs_queue: { type: "infrastructureNode", technology: "Amazon SQS", matches: /\bsqs\b/i },
  aws_sns_topic: { type: "infrastructureNode", technology: "Amazon SNS", matches: /\bsns\b/i },
  aws_ecs_service: {
    type: "deploymentNode",
    technology: "Amazon ECS",
    matches: /\becs\b|fargate/i,
    instances: "desired_count",
  },
  aws_lambda_function: { type: "deploymentNode", technology: "AWS Lambda", matches: /lambda/i },
  aws_instance: { type: "deploymentNode", technology: "Amazon EC2", matches: /\bec2\b/i, instances: "count" },
  aws_db_instance: rds,
  aws_rds_cluster: rds,
  aws_dynamodb_table: { type: "deploymentNode", technology: "Amazon DynamoDB", matches: /dynamodb/i },
  aws_elasticache_cluster: {
    type: "deploymentNode",
    technology: "Amazon ElastiCache",
    matches: /elasticache/i,
    instances: "num_cache_nodes",
  },
  aws_elasticache_replication_group: {
    type: "deploymentNode",
    technology: "Amazon ElastiCache",
    matches: /elasticache/i,
    instances: "num_cache_clusters",
  },
  aws_s3_bucket: { type: "deploymentNode", technology: "Amazon S3", matches: /\bs3\b/i },
};

// AWS resource types that configure, connect or secure a node rather than being one. A type matches an entry
// ending in "_" by prefix. Keep in step with docs/product-spec.md.
export const supportingResources = [
  "aws_acm_",
  "aws_api_gateway_",
  "aws_apigatewayv2_",
  "aws_appautoscaling_",
  "aws_cloudfront_cache_policy",
  "aws_cloudfront_origin_access_control",
  "aws_cloudfront_origin_access_identity",
  "aws_cloudwatch_",
  "aws_db_parameter_group",
  "aws_db_subnet_group",
  "aws_ecs_cluster",
  "aws_ecs_cluster_capacity_providers",
  "aws_ecs_task_definition",
  "aws_eip",
  "aws_elasticache_parameter_group",
  "aws_elasticache_subnet_group",
  "aws_iam_",
  "aws_internet_gateway",
  "aws_kms_",
  "aws_lambda_permission",
  "aws_lb_",
  "aws_nat_gateway",
  "aws_rds_cluster_instance",
  "aws_route",
  "aws_route_table",
  "aws_route_table_association",
  "aws_route53_",
  "aws_s3_bucket_",
  "aws_secretsmanager_",
  "aws_security_group",
  "aws_security_group_rule",
  "aws_sns_topic_",
  "aws_sqs_queue_",
  "aws_ssm_parameter",
  "aws_subnet",
  "aws_vpc",
  "aws_vpc_",
];

const supporting = (type: string) =>
  supportingResources.some((entry) => (entry.endsWith("_") ? type.startsWith(entry) : type === entry));

// A target deployment node names the resource it stands for with this property, for when matching by technology
// can't tell two nodes apart.
export const terraformProperty = "bearing.terraform";

// Reads the `.tf` files in `iac.terraform`, one root module as Terraform reads it, and turns each resource of a
// mapped type into a deployment node.
//
// Nodes are matched with the target's deployment nodes in its one environment: first by `bearing.terraform`, then
// by technology where a kind of node has exactly one resource and one target node left. A resource that matches
// nothing keeps its address as its ID, so it reads as an added node.
export function deriveTerraform(config: Config, target: Model): TerraformGraph {
  const dir = config.iac.terraform;
  if (dir === undefined) throw new TerraformError('"iac.terraform" is not set in .bearing/config.yaml');
  const environment = environmentOf(target);
  const resources = readModule(resolve(config.root, dir), posix.normalize(dir.split("\\").join("/")));

  const unknown: TerraformResource[] = [];
  const found: Array<{ node: TerraformNode; mapping: Mapping }> = [];
  for (const block of resources) {
    const resource = { address: block.address, file: block.file, line: block.line };
    const mapping = block.type === undefined ? undefined : resourceMappings[block.type];
    if (mapping === undefined) {
      if (block.type === undefined || !supporting(block.type)) unknown.push(resource);
      continue;
    }
    const node: TerraformNode = { id: block.address, type: mapping.type, technology: mapping.technology, resource };
    const instances = mapping.instances === undefined ? undefined : block.attributes.get(mapping.instances);
    if (instances !== undefined && /^\d+$/.test(instances)) node.instances = instances;
    found.push({ node, mapping });
  }

  const candidates = [...target.deployment.values()].filter(
    (element) =>
      element.environment === environment &&
      (element.type === "deploymentNode" || element.type === "infrastructureNode"),
  );
  const taken = new Set<string>();
  for (const { node } of found) {
    const pinned = candidates.find((candidate) => candidate.properties[terraformProperty] === node.resource.address);
    if (pinned !== undefined && !taken.has(pinned.id)) {
      node.id = pinned.id;
      taken.add(pinned.id);
    }
  }
  const unpinned = found.filter(({ node }) => node.id === node.resource.address);
  for (const technology of new Set(unpinned.map(({ node }) => node.technology))) {
    const resources = unpinned.filter(({ node }) => node.technology === technology);
    const nodes = candidates.filter(
      (candidate) =>
        !taken.has(candidate.id) &&
        candidate.properties[terraformProperty] === undefined &&
        resources[0]!.mapping.matches.test(candidate.technology),
    );
    if (resources.length === 1 && nodes.length === 1) {
      resources[0]!.node.id = nodes[0]!.id;
      taken.add(nodes[0]!.id);
    }
  }

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    environment,
    nodes: found.map(({ node }) => node).sort(byId),
    unknown: unknown.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)),
  };
}

// The as-built model the Terraform gives, for diffing with the target. Nodes Terraform can't speak to are copied
// from the target so they don't read as removed: other environments, nodes of no mapped technology (such as a
// region grouping the rest) and the instances inside nodes that are still there. A target node of a mapped
// technology with no resource is left out, so it reads as removed.
export function terraformModel(target: Model, graph: TerraformGraph): Model {
  const model: Model = {
    elements: new Map(),
    relationships: new Map(),
    dynamicViews: new Map(),
    deployment: new Map(),
  };
  const mappings = Object.values(resourceMappings);
  const checked = (element: DeploymentElement) =>
    element.environment === graph.environment &&
    (element.type === "deploymentNode" || element.type === "infrastructureNode") &&
    (element.properties[terraformProperty] !== undefined ||
      mappings.some((mapping) => mapping.matches.test(element.technology)));
  for (const element of target.deployment.values()) {
    if (!checked(element) && element.type !== "containerInstance" && element.type !== "softwareSystemInstance") {
      model.deployment.set(element.id, element);
    }
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
    const instance = element.type === "containerInstance" || element.type === "softwareSystemInstance";
    if (instance && element.parent !== undefined && model.deployment.has(element.parent)) {
      model.deployment.set(element.id, element);
    }
  }
  return model;
}

// Terraform has no environments of its own, so the target must have just one to compare it with.
function environmentOf(target: Model): string {
  const environments = [...new Set([...target.deployment.values()].map((element) => element.environment))].sort();
  if (environments.length === 1) return environments[0]!;
  if (environments.length === 0) {
    throw new TerraformError('the target has no deployment view to compare "iac.terraform" with');
  }
  throw new TerraformError(
    `the target has ${environments.length} deployment environments (${environments.join(", ")}); comparing Terraform with more than one isn't supported yet`,
  );
}

interface Block {
  address: string;
  // The resource type; absent for a module.
  type?: string;
  file: string;
  line: number;
  // Top-level attributes whose value is a plain number or string.
  attributes: Map<string, string>;
}

function readModule(dir: string, repoDir: string): Block[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new TerraformError(`${repoDir} not found; check "iac.terraform" in .bearing/config.yaml`);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".tf"))
    .sort();
  return files.flatMap((name) => parseBlocks(readFileSync(join(dir, name), "utf8"), posix.join(repoDir, name)));
}

interface Token {
  // A template is a string with interpolation, or a heredoc: its value isn't known without evaluating it.
  kind: "word" | "string" | "template" | "punct" | "newline";
  text: string;
  line: number;
}

// Finds the `resource` and `module` blocks in one file of HCL. It reads only as much of the language as that needs:
// block labels, nesting, and top-level attributes with a literal value.
export function parseBlocks(text: string, file: string): Block[] {
  const tokens = tokenize(text, file);
  const blocks: Block[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "punct" && "{[(".includes(token.text)) depth++;
    else if (token.kind === "punct" && "}])".includes(token.text)) depth--;
    if (depth !== 0 || token.kind !== "word" || (i > 0 && tokens[i - 1]!.kind !== "newline")) continue;
    const labels: string[] = [];
    let j = i + 1;
    while (tokens[j]?.kind === "string" || (tokens[j]?.kind === "word" && tokens[j + 1]?.text !== "=")) {
      labels.push(tokens[j]!.text);
      j++;
    }
    if (tokens[j]?.text !== "{") continue;
    if (token.text === "resource" && labels.length === 2) {
      const body = attributesOf(tokens, j);
      blocks.push({ address: `${labels[0]}.${labels[1]}`, type: labels[0], file, line: token.line, attributes: body });
    } else if (token.text === "module" && labels.length === 1) {
      blocks.push({ address: `module.${labels[0]}`, file, line: token.line, attributes: new Map() });
    }
  }
  return blocks;
}

// The literal top-level attributes of the block whose `{` is at `open`.
function attributesOf(tokens: Token[], open: number): Map<string, string> {
  const attributes = new Map<string, string>();
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "punct" && "{[(".includes(token.text)) depth++;
    else if (token.kind === "punct" && "}])".includes(token.text) && --depth === 0) break;
    const [equals, value, end] = [tokens[i + 1], tokens[i + 2], tokens[i + 3]];
    if (
      depth === 1 &&
      token.kind === "word" &&
      (tokens[i - 1]!.kind === "newline" || tokens[i - 1]!.text === "{") &&
      equals?.text === "=" &&
      (value?.kind === "word" || value?.kind === "string") &&
      (end?.kind === "newline" || end?.text === "}")
    ) {
      attributes.set(token.text, value.text);
    }
  }
  return attributes;
}

// Splits HCL into words, strings, templates, punctuation and newlines, dropping comments. A string's text is its
// contents; a template's is empty.
function tokenize(text: string, file: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  const fail = (message: string): never => {
    throw new TerraformError(`${file}:${line}: ${message}`);
  };

  // Skips a quoted string from its opening quote, returning its contents if it has no interpolation.
  const skipString = (): string | undefined => {
    let literal = true;
    let value = "";
    for (i++; i < text.length; i++) {
      const c = text[i]!;
      if (c === "\n") fail("unterminated string");
      if (c === "\\") {
        value += text[++i] ?? "";
      } else if (c === '"') {
        i++;
        return literal ? value : undefined;
      } else if ((c === "$" || c === "%") && text[i + 1] === "{") {
        literal = false;
        i += 2;
        skipExpression();
        i--;
      } else {
        value += c;
      }
    }
    return fail("unterminated string");
  };

  // Skips an interpolation's expression up to and past its closing brace.
  const skipExpression = () => {
    let depth = 1;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        skipString();
        continue;
      }
      if (c === "\n") line++;
      if (c === "{") depth++;
      if (c === "}" && --depth === 0) {
        i++;
        return;
      }
      i++;
    }
    fail("unterminated interpolation");
  };

  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i, i + 2);
    if (c === "\n") {
      tokens.push({ kind: "newline", text: "\n", line });
      line++;
      i++;
    } else if (c === "#" || rest === "//") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (rest === "/*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) fail("unterminated comment");
      for (const skipped of text.slice(i, end)) if (skipped === "\n") line++;
      i = end + 2;
    } else if (c === '"') {
      const start = line;
      const value = skipString();
      tokens.push(
        value === undefined
          ? { kind: "template", text: "", line: start }
          : { kind: "string", text: value, line: start },
      );
    } else if (rest === "<<" && /^<<-?[A-Za-z_]/.test(text.slice(i, i + 4))) {
      const match = /^<<-?([A-Za-z_][\w-]*)[^\S\n]*\n/.exec(text.slice(i));
      if (match === null) fail("malformed heredoc");
      const marker = new RegExp(`^[^\\S\\n]*${match![1]}[^\\S\\n]*$`, "m");
      const body = text.slice(i + match![0].length);
      const end = marker.exec(body);
      if (end === null) fail(`heredoc ${match![1]} is never closed`);
      tokens.push({ kind: "template", text: "", line });
      // Up to the end of the closing marker, leaving the newline after it to end the attribute.
      const skipped = match![0] + body.slice(0, end!.index + end![0].length);
      for (const char of skipped) if (char === "\n") line++;
      i += skipped.length;
    } else if (/[\w.-]/.test(c)) {
      const word = /^[\w.-]+/.exec(text.slice(i))![0];
      tokens.push({ kind: "word", text: word, line });
      i += word.length;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      tokens.push({ kind: "punct", text: c, line });
      i++;
    }
  }
  return tokens;
}
