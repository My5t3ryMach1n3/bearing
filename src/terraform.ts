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
export function deriveTerraform(config: Config, target: Model, blocks = readTerraform(config)): TerraformGraph {
  const environment = environmentOf(target);

  const unknown: TerraformResource[] = [];
  const found: Array<{ node: TerraformNode; mapping: Mapping }> = [];
  for (const block of blocks) {
    // A data source deploys nothing.
    if (block.kind === "data") continue;
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

// A top-level block of a `.tf` file that Bearing reads.
export interface Block {
  kind: "resource" | "data" | "module";
  // As Terraform writes it: "aws_ecs_service.basket_api", "data.aws_iam_policy_document.send" or "module.network".
  address: string;
  // The resource or data source type; absent for a module.
  type?: string;
  // The resource's or data source's name, e.g. "basket_api".
  name: string;
  file: string;
  line: number;
  // Top-level attributes whose value is a plain number, word or string.
  attributes: Map<string, string>;
  body: Body;
}

// What a block holds: its attributes, with their expressions, and the blocks nested in it.
export interface Body {
  attributes: Map<string, Value>;
  blocks: NestedBlock[];
}

export interface NestedBlock {
  type: string;
  labels: string[];
  line: number;
  body: Body;
}

// An HCL expression, read as far as Bearing needs: literals, references, collections and function calls. Anything
// else, such as an operator, a conditional or a `for` expression, is an `expression` holding the parts it's made of.
export type Value =
  | { kind: "string"; value: string }
  // A quoted string with interpolation, or a heredoc: its text as written, `${...}` included.
  | { kind: "template"; text: string; line: number }
  // A number, `true`, `false`, `null` or a reference such as `aws_sqs_queue.events.arn`. An index or splat after a
  // reference is dropped: `aws_sqs_queue.events[0].arn` reads as `aws_sqs_queue.events`.
  | { kind: "word"; value: string }
  | { kind: "tuple"; items: Value[] }
  | { kind: "object"; entries: Array<{ key: string; value: Value }>; line: number }
  | { kind: "call"; name: string; args: Value[] }
  | { kind: "expression"; parts: Value[] };

// Every block in a Terraform directory: one root module, as Terraform reads it. Modules aren't followed.
export function readTerraform(config: Config): Block[] {
  const dir = config.iac.terraform;
  if (dir === undefined) throw new TerraformError('"iac.terraform" is not set in .bearing/config.yaml');
  return readModule(resolve(config.root, dir), posix.normalize(dir.split("\\").join("/")));
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
  // A string's contents, a template's text as written, or the word or punctuation itself.
  text: string;
  line: number;
}

// Finds the `resource`, `data` and `module` blocks in one file of HCL.
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
    const kind = token.text;
    if ((kind === "resource" || kind === "data") && labels.length === 2) {
      const body = new Parser(tokens).body(j);
      const address = kind === "data" ? `data.${labels[0]}.${labels[1]}` : `${labels[0]}.${labels[1]}`;
      blocks.push({
        kind,
        address,
        type: labels[0]!,
        name: labels[1]!,
        file,
        line: token.line,
        attributes: literalAttributes(body),
        body,
      });
    } else if (kind === "module" && labels.length === 1) {
      blocks.push({
        kind,
        address: `module.${labels[0]}`,
        name: labels[0]!,
        file,
        line: token.line,
        attributes: new Map(),
        body: { attributes: new Map(), blocks: [] },
      });
    }
  }
  return blocks;
}

function literalAttributes(body: Body): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [name, value] of body.attributes) {
    if (value.kind === "string" || value.kind === "word") attributes.set(name, value.value);
  }
  return attributes;
}

// Reads block bodies and expressions from the tokens. It never throws: what it can't read becomes an `expression`,
// and a line it can't read at all is skipped.
class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private is(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token !== undefined && token.kind === "punct" && token.text === text;
  }

  private skipNewlines() {
    while (this.peek()?.kind === "newline") this.i++;
  }

  // The body of the block whose `{` is at `open`.
  body(open: number): Body {
    this.i = open + 1;
    return this.readBody();
  }

  private readBody(): Body {
    const body: Body = { attributes: new Map(), blocks: [] };
    for (;;) {
      this.skipNewlines();
      const token = this.peek();
      if (token === undefined) return body;
      if (this.is("}")) {
        this.i++;
        return body;
      }
      if (token.kind === "word" && this.is("=", 1) && !this.is("=", 2)) {
        this.i += 2;
        body.attributes.set(token.text, this.sequence(["\n", "}"]));
        continue;
      }
      if (token.kind === "word") {
        const labels: string[] = [];
        let offset = 1;
        while (this.peek(offset)?.kind === "string" || this.peek(offset)?.kind === "word") {
          labels.push(this.peek(offset)!.text);
          offset++;
        }
        if (this.is("{", offset)) {
          this.i += offset + 1;
          body.blocks.push({ type: token.text, labels, line: token.line, body: this.readBody() });
          continue;
        }
      }
      // Not an attribute or a block: skip the line, and any brackets it opens.
      this.sequence(["\n", "}"]);
    }
  }

  // An expression running up to one of `stops` outside any brackets, which is left unread. A newline is a stop only
  // if `stops` has one; otherwise it's skipped.
  private sequence(stops: string[]): Value {
    const parts: Value[] = [];
    let operators = 0;
    for (;;) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === "newline") {
        if (stops.includes("\n")) break;
        this.i++;
        continue;
      }
      if (token.kind === "punct" && stops.includes(token.text)) break;
      const value = this.primary();
      if (value === undefined) operators++;
      else parts.push(value);
    }
    if (parts.length === 1 && operators === 0) return parts[0]!;
    return { kind: "expression", parts };
  }

  // One literal, reference, collection or call, or undefined after skipping an operator or a stray closing bracket.
  private primary(): Value | undefined {
    const token = this.peek()!;
    this.i++;
    switch (token.kind) {
      case "string":
        return { kind: "string", value: token.text };
      case "template":
        return { kind: "template", text: token.text, line: token.line };
      case "word": {
        if (this.is("(")) {
          this.i++;
          const args = this.list(")");
          return { kind: "call", name: token.text, args };
        }
        // Indexes, splats and the attributes after them.
        while (this.is("[") || (this.peek()?.kind === "word" && this.peek()!.text.startsWith("."))) {
          if (this.is("[")) {
            this.i++;
            this.sequence(["]"]);
            if (this.is("]")) this.i++;
          } else {
            this.i++;
          }
        }
        return { kind: "word", value: token.text };
      }
      case "newline":
        return undefined;
      case "punct":
        break;
    }
    switch (token.text) {
      case "[":
        if (this.peek()?.text === "for") return this.rest("]");
        return { kind: "tuple", items: this.list("]") };
      case "{":
        this.skipNewlines();
        if (this.peek()?.text === "for") return this.rest("}");
        return this.object(token.line);
      case "(": {
        const inner = this.sequence([")"]);
        if (this.is(")")) this.i++;
        return inner;
      }
      default:
        return undefined;
    }
  }

  // Comma-separated items up to `close`, which is read.
  private list(close: string): Value[] {
    const items: Value[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.peek() === undefined) return items;
      if (this.is(close)) {
        this.i++;
        return items;
      }
      if (this.is(",")) {
        this.i++;
        continue;
      }
      const item = this.sequence([",", close]);
      if (item.kind !== "expression" || item.parts.length > 0) items.push(item);
    }
  }

  // Everything up to `close`, such as a `for` expression, as one expression.
  private rest(close: string): Value {
    const value = this.sequence([close]);
    if (this.is(close)) this.i++;
    return value.kind === "expression" ? value : { kind: "expression", parts: [value] };
  }

  // An object's entries up to its `}`: `key = value` or `key: value`, separated by commas or newlines.
  private object(line: number): Value {
    const entries: Array<{ key: string; value: Value }> = [];
    for (;;) {
      this.skipNewlines();
      const token = this.peek();
      if (token === undefined) break;
      if (this.is("}")) {
        this.i++;
        break;
      }
      if (this.is(",")) {
        this.i++;
        continue;
      }
      if ((token.kind === "word" || token.kind === "string") && (this.is("=", 1) || this.is(":", 1))) {
        this.i += 2;
        entries.push({ key: token.text, value: this.sequence([",", "\n", "}"]) });
        continue;
      }
      this.sequence([",", "\n", "}"]);
    }
    return { kind: "object", entries, line };
  }
}

// Splits HCL into words, strings, templates, punctuation and newlines, dropping comments. A string's text is its
// contents; a template's is its text as written.
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
      const from = i + 1;
      const value = skipString();
      tokens.push(
        value === undefined
          ? { kind: "template", text: text.slice(from, i - 1), line: start }
          : { kind: "string", text: value, line: start },
      );
    } else if (rest === "<<" && /^<<-?[A-Za-z_]/.test(text.slice(i, i + 4))) {
      const match = /^<<-?([A-Za-z_][\w-]*)[^\S\n]*\n/.exec(text.slice(i));
      if (match === null) fail("malformed heredoc");
      const marker = new RegExp(`^[^\\S\\n]*${match![1]}[^\\S\\n]*$`, "m");
      const body = text.slice(i + match![0].length);
      const end = marker.exec(body);
      if (end === null) fail(`heredoc ${match![1]} is never closed`);
      tokens.push({ kind: "template", text: body.slice(0, end!.index), line });
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
