import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { diffModels } from "../src/diff.js";
import { modelFromWorkspace, type DeploymentElement, type Model } from "../src/model.js";
import {
  deriveTerraform,
  parseBlocks,
  resourceMappings,
  supportingResources,
  TerraformError,
  terraformModel,
} from "../src/terraform.js";
import { basketDir, copyBasket } from "./basket.js";

const basketTarget = modelFromWorkspace(JSON.parse(readFileSync(join(basketDir, "workspace.json"), "utf8")));

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

// Writes Terraform files under `infra/` in a temp repo and returns its config.
function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "bearing-terraform-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "infra", path)), { recursive: true });
    writeFileSync(join(root, "infra", path), text);
  }
  mkdirSync(join(root, "infra"), { recursive: true });
  return parseConfig(
    "version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\niac:\n  terraform: infra/\n",
    root,
  );
}

const deploymentDiff = (target: Model, config = loadConfig(join(basketDir, "repo"))) => {
  const diff = diffModels(target, terraformModel(target, deriveTerraform(config, target))).deployment;
  return {
    added: diff.added.map(({ id }) => id),
    removed: diff.removed.map(({ id }) => id),
    drifted: diff.drifted,
  };
};

describe("parseBlocks", () => {
  it("finds resource and module blocks with their lines and literal attributes", () => {
    const blocks = parseBlocks(
      [
        '# a comment with resource "x" "y" {',
        'resource "aws_ecs_service" "api" {',
        '  name          = "api"',
        "  desired_count = 2",
        "  cluster       = aws_ecs_cluster.main.id",
        "  network_configuration {",
        "    desired_count = 9",
        "  }",
        "}",
        "",
        'module "network" {',
        '  source = "./network"',
        "}",
      ].join("\n"),
      "infra/main.tf",
    );
    expect(blocks).toEqual([
      {
        address: "aws_ecs_service.api",
        type: "aws_ecs_service",
        file: "infra/main.tf",
        line: 2,
        attributes: new Map([
          ["name", "api"],
          ["desired_count", "2"],
          ["cluster", "aws_ecs_cluster.main.id"],
        ]),
      },
      { address: "module.network", file: "infra/main.tf", line: 11, attributes: new Map() },
    ]);
  });

  it("isn't thrown by braces in strings, interpolations, heredocs and comments", () => {
    const blocks = parseBlocks(
      [
        '/* resource "aws_s3_bucket" "commented" {',
        "} */",
        'resource "aws_iam_policy" "p" {',
        "  policy = <<-EOF",
        '    { "Statement": [ { "Effect": "Allow" } ] }',
        '    resource "aws_s3_bucket" "in_heredoc" {',
        "  EOF",
        '  name = "${var.prefix}-{policy}"',
        '  tags = { Name = "}${jsonencode({ a = "}" })}" }',
        "}",
        '// resource "aws_s3_bucket" "commented" {',
        'resource "aws_s3_bucket" "b" { bucket = "b" }',
      ].join("\n"),
      "infra/main.tf",
    );
    expect(blocks.map(({ address, line }) => [address, line])).toEqual([
      ["aws_iam_policy.p", 3],
      ["aws_s3_bucket.b", 12],
    ]);
    expect(blocks[0]!.attributes.has("name")).toBe(false);
    expect(blocks[1]!.attributes.get("bucket")).toBe("b");
  });

  it("names the file and line of an unterminated string", () => {
    expect(() => parseBlocks('resource "a" "b" {\n  x = "oops\n}\n', "infra/main.tf")).toThrow(
      new TerraformError("infra/main.tf:2: unterminated string"),
    );
  });
});

describe("deriveTerraform", () => {
  it("maps known resource types to nodes and reports unknown ones and modules", () => {
    const config = repo({
      "main.tf": [
        'resource "aws_db_instance" "db" {}',
        'resource "aws_db_subnet_group" "db" {}',
        'resource "aws_iam_role" "task" {}',
        'resource "aws_mq_broker" "events" {}',
        'resource "random_password" "db" {}',
        'module "network" {',
        '  source = "./network"',
        "}",
        'data "aws_vpc" "main" {}',
      ].join("\n"),
    });
    const graph = deriveTerraform(config, target({ db: "Amazon RDS for PostgreSQL" }));
    expect(graph).toEqual({
      environment: "Production",
      nodes: [
        {
          id: "db",
          type: "deploymentNode",
          technology: "Amazon RDS",
          resource: { address: "aws_db_instance.db", file: "infra/main.tf", line: 1 },
        },
      ],
      unknown: [
        { address: "aws_mq_broker.events", file: "infra/main.tf", line: 4 },
        { address: "module.network", file: "infra/main.tf", line: 6 },
        { address: "random_password.db", file: "infra/main.tf", line: 5 },
      ],
    });
  });

  it("matches by technology only when one resource and one node are left of a kind", () => {
    const config = repo({
      "main.tf": 'resource "aws_s3_bucket" "a" {}\nresource "aws_s3_bucket" "b" {}\nresource "aws_sqs_queue" "q" {}\n',
    });
    const graph = deriveTerraform(config, target({ files: "Amazon S3", queue: "Amazon SQS" }));
    expect(graph.nodes.map(({ id }) => id)).toEqual(["aws_s3_bucket.a", "aws_s3_bucket.b", "queue"]);
  });

  it("matches a node to the resource its bearing.terraform property names", () => {
    const config = repo({ "main.tf": 'resource "aws_s3_bucket" "a" {}\nresource "aws_s3_bucket" "b" {}\n' });
    const pinned = (address: string) => ({ technology: "Amazon S3", properties: { "bearing.terraform": address } });
    const graph = deriveTerraform(
      config,
      target({ first: pinned("aws_s3_bucket.a"), second: pinned("aws_s3_bucket.b") }),
    );
    expect(graph.nodes.map(({ id, resource }) => [id, resource.address])).toEqual([
      ["first", "aws_s3_bucket.a"],
      ["second", "aws_s3_bucket.b"],
    ]);
  });

  it("reads every .tf file in the directory but not its subdirectories", () => {
    const config = repo({
      "a.tf": 'resource "aws_s3_bucket" "a" {}\n',
      "b.tf": 'resource "aws_sqs_queue" "b" {}\n',
      "notes.md": 'resource "aws_sns_topic" "c" {}\n',
      "modules/x/main.tf": 'resource "aws_sns_topic" "d" {}\n',
    });
    const graph = deriveTerraform(config, target({ x: "" }));
    expect(graph.nodes.map(({ resource }) => resource.file)).toEqual(["infra/a.tf", "infra/b.tf"]);
  });

  it("explains a missing directory and a target with several environments", () => {
    const config = repo({});
    config.iac.terraform = "terraform/";
    expect(() => deriveTerraform(config, target({ x: "" }))).toThrow(/terraform\/ not found; check "iac.terraform"/);
    const twoEnvironments = target({ a: "", b: { environment: "Staging" } });
    expect(() => deriveTerraform(repo({}), twoEnvironments)).toThrow(
      /2 deployment environments \(Production, Staging\)/,
    );
  });

  it("covers every mapped type in the docs table", () => {
    const spec = readFileSync(join(import.meta.dirname, "..", "docs", "product-spec.md"), "utf8");
    for (const type of [...Object.keys(resourceMappings), ...supportingResources]) {
      expect(spec, type).toContain(`\`${type.endsWith("_") ? `${type}*` : type}\``);
    }
  });
});

describe("terraformModel", () => {
  it("reads instance counts as drift and target nodes with no resource as removed", () => {
    const config = repo({ "main.tf": 'resource "aws_ecs_service" "api" {\n  desired_count = 3\n}\n' });
    const nodes = target({
      aws: "",
      api: { technology: "AWS Fargate", parent: "aws", instances: "2" },
      "api/app": { type: "containerInstance", parent: "api", element: "app" },
      db: { technology: "Amazon RDS", parent: "aws" },
      "db/data": { type: "containerInstance", parent: "db", element: "data" },
    });
    expect(deploymentDiff(nodes, config)).toEqual({
      added: [],
      removed: ["db", "db/data"],
      drifted: [{ id: "api", changes: [{ field: "instances", from: "2", to: "3" }] }],
    });
  });
});

describe("deriveTerraform on the basket fixture", () => {
  it("matches every node in the target's deployment view on main", () => {
    const graph = deriveTerraform(loadConfig(join(basketDir, "repo")), basketTarget);
    expect(graph.nodes.map(({ id, resource }) => [id, resource.address])).toEqual([
      ["cdn", "aws_cloudfront_distribution.web_app"],
      ["ecs", "aws_ecs_service.basket_api"],
      ["lb", "aws_lb.basket_api"],
      ["rds", "aws_db_instance.basket"],
      ["site", "aws_s3_bucket.web_app"],
    ]);
    expect(graph.unknown).toEqual([]);
    expect(deploymentDiff(basketTarget)).toEqual({ added: [], removed: [], drifted: [] });
  });

  it("finds the Redis cluster as a node the target doesn't have", () => {
    const config = loadConfig(copyBasket("redis-node"));
    expect(deploymentDiff(basketTarget, config)).toEqual({
      added: ["aws_elasticache_cluster.basket"],
      removed: [],
      drifted: [],
    });
  });
});
