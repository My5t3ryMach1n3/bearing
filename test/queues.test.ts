import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkClaim, checkQueueBoundaries } from "../src/check.js";
import { parseConfig } from "../src/config.js";
import type { DeploymentElement, Element, Model, Relationship } from "../src/model.js";
import { deriveQueues } from "../src/queues.js";
import { deriveTerraform } from "../src/terraform.js";

// Writes Terraform files under `infra/` in a temp repo and returns its config.
function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "bearing-queues-"));
  mkdirSync(join(root, "infra"), { recursive: true });
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, "infra", path), text);
  return parseConfig(
    "version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\niac:\n  terraform: infra/\n",
    root,
  );
}

const element = (id: string, type: Element["type"], parent?: string, extra: Partial<Element> = {}): Element => ({
  id,
  type,
  name: id,
  description: "",
  technology: "",
  tags: [],
  requirements: [],
  properties: {},
  ...(parent === undefined ? {} : { parent }),
  ...extra,
});

const relationship = (source: string, destination: string): Relationship => ({
  id: `${source}->${destination}`,
  source,
  destination,
  description: "",
  technology: "",
  tags: [],
  requirements: [],
  properties: {},
});

const node = (id: string, technology: string, extra: Partial<DeploymentElement> = {}): DeploymentElement => ({
  id,
  type: "deploymentNode",
  environment: "Production",
  name: id,
  description: "",
  technology,
  tags: [],
  properties: {},
  ...extra,
});

// The Chairside target from the worked example, cut down to what the queue touches: the booking API and the reminder
// worker, each on an ECS service, and the queue between them.
function chairside(relationships: Array<[string, string]> = defaultRelationships): Model {
  const elements = [
    element("chairside", "softwareSystem"),
    element("bookingApi", "container", "chairside", { technology: "Python, FastAPI" }),
    element("bookingService", "component", "bookingApi", { path: "services/booking-api/app/booking" }),
    element("eventPublisher", "component", "bookingApi", { path: "services/booking-api/app/events" }),
    element("reminderWorker", "container", "chairside", { technology: "Go" }),
    element("eventConsumer", "component", "reminderWorker", { path: "services/reminder-worker/internal/consumer" }),
    element("scheduler", "component", "reminderWorker", { path: "services/reminder-worker/internal/schedule" }),
    element("appointmentEvents", "container", "chairside", { technology: "SQS", tags: ["Queue"] }),
  ];
  const deployment = [
    node("aws", "Amazon Web Services"),
    node("api", "Amazon ECS on Fargate", { parent: "aws" }),
    {
      ...node("api/bookingApi", "", { parent: "api", element: "bookingApi" }),
      type: "containerInstance" as const,
    },
    node("worker", "Amazon ECS on Fargate", { parent: "aws" }),
    {
      ...node("worker/reminderWorker", "", { parent: "worker", element: "reminderWorker" }),
      type: "containerInstance" as const,
    },
    { ...node("queue", "Amazon SQS", { parent: "aws" }), type: "infrastructureNode" as const },
  ];
  // The two ECS services are told apart by their bearing.terraform properties.
  deployment[1]!.properties["bearing.terraform"] = "aws_ecs_service.booking_api";
  deployment[3]!.properties["bearing.terraform"] = "aws_ecs_service.reminder_worker";
  return {
    elements: new Map(elements.map((each) => [each.id, each])),
    relationships: new Map(
      relationships.map(([source, destination]) => {
        const each = relationship(source, destination);
        return [each.id, each];
      }),
    ),
    dynamicViews: new Map(),
    deployment: new Map(deployment.map((each) => [each.id, each])),
  };
}

const defaultRelationships: Array<[string, string]> = [
  ["bookingService", "eventPublisher"],
  ["eventPublisher", "appointmentEvents"],
  ["appointmentEvents", "eventConsumer"],
  ["eventConsumer", "scheduler"],
];

const services = `
resource "aws_ecs_task_definition" "booking_api" {
  family        = "booking-api"
  task_role_arn = aws_iam_role.booking_api_task.arn
  execution_role_arn = aws_iam_role.ecs_execution.arn
}

resource "aws_ecs_service" "booking_api" {
  name            = "booking-api"
  task_definition = aws_ecs_task_definition.booking_api.arn
  desired_count   = 2
}

resource "aws_ecs_task_definition" "reminder_worker" {
  family        = "reminder-worker"
  task_role_arn = aws_iam_role.reminder_worker_task.arn
}

resource "aws_ecs_service" "reminder_worker" {
  name            = "reminder-worker"
  task_definition = aws_ecs_task_definition.reminder_worker.arn
}

resource "aws_sqs_queue" "appointment_events" {
  name = "appointment-events"
}

resource "aws_iam_role" "ecs_execution" {
  name = "ecs-execution"
}
`;

const roles = `
resource "aws_iam_role" "booking_api_task" {
  name = "booking-api-task"
}

resource "aws_iam_role" "reminder_worker_task" {
  name = "reminder-worker-task"
}
`;

// The worked example's IAM: the API's role may send, written with jsonencode, and the worker's may receive, through a
// policy document attached as a managed policy.
const iam = `
resource "aws_iam_role_policy" "booking_api_publish" {
  role = aws_iam_role.booking_api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:GetQueueUrl"]
        Resource = aws_sqs_queue.appointment_events.arn
      },
    ]
  })
}

data "aws_iam_policy_document" "consume" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage"]
    resources = [aws_sqs_queue.appointment_events.arn]
  }
}

resource "aws_iam_policy" "consume" {
  name   = "consume-appointment-events"
  policy = data.aws_iam_policy_document.consume.json
}

resource "aws_iam_role_policy_attachment" "reminder_worker_consume" {
  role       = aws_iam_role.reminder_worker_task.name
  policy_arn = aws_iam_policy.consume.arn
}

# The execution role pulls images and writes logs; it isn't the role the code runs as.
resource "aws_iam_role_policy" "execution" {
  role   = aws_iam_role.ecs_execution.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "sqs:*", Resource = "*" }] })
}
`;

const ids = (relationships: Array<{ id: string }>) => relationships.map(({ id }) => id);

describe("deriveQueues", () => {
  it("derives the worked example's eventPublisher -> appointmentEvents -> eventConsumer", () => {
    const config = repo({ "services.tf": services, "roles.tf": roles, "iam.tf": iam });
    const queues = deriveQueues(config, chairside());
    expect(queues).toEqual([
      {
        id: "appointmentEvents->eventConsumer",
        source: "appointmentEvents",
        destination: "eventConsumer",
        direction: "receive",
        grants: [
          {
            node: "aws_ecs_service.reminder_worker",
            role: "aws_iam_role.reminder_worker_task",
            policy: { address: "data.aws_iam_policy_document.consume", file: "infra/iam.tf", line: 17 },
            actions: ["sqs:ReceiveMessage"],
          },
        ],
      },
      {
        id: "eventPublisher->appointmentEvents",
        source: "eventPublisher",
        destination: "appointmentEvents",
        direction: "send",
        grants: [
          {
            node: "aws_ecs_service.booking_api",
            role: "aws_iam_role.booking_api_task",
            policy: { address: "aws_iam_role_policy.booking_api_publish", file: "infra/iam.tf", line: 7 },
            actions: ["sqs:SendMessage"],
          },
        ],
      },
    ]);
    expect(checkQueueBoundaries(chairside(), queues)).toEqual([]);
    // Every resource is a node or supports one, and the data source deploys nothing.
    expect(deriveTerraform(config, chairside()).unknown).toEqual([]);
  });

  it("leaves a grant on the container when the target declares none of its components with the queue", () => {
    const config = repo({ "services.tf": services, "roles.tf": roles, "iam.tf": iam });
    const target = chairside([["appointmentEvents", "eventConsumer"]]);
    const queues = deriveQueues(config, target);
    expect(ids(queues)).toEqual(["appointmentEvents->eventConsumer", "bookingApi->appointmentEvents"]);
    expect(ids(checkQueueBoundaries(target, queues))).toEqual(["bookingApi->appointmentEvents"]);
    // Declared on the container, it passes.
    const declared = chairside([
      ["appointmentEvents", "eventConsumer"],
      ["bookingApi", "appointmentEvents"],
    ]);
    expect(checkQueueBoundaries(declared, deriveQueues(config, declared))).toEqual([]);
  });

  it("reads inline policies, heredoc JSON, managed policy ARNs, wildcards and literal ARNs", () => {
    const config = repo({
      "services.tf": services,
      "iam.tf": `
resource "aws_iam_role" "booking_api_task" {
  name = "booking-api-task"
  inline_policy {
    name   = "publish"
    policy = <<-EOF
      {
        "Statement": [
          { "Effect": "Allow", "Action": "sqs:Send*", "Resource": "\${aws_sqs_queue.appointment_events.arn}" }
        ]
      }
    EOF
  }
}

resource "aws_iam_policy" "consume" {
  policy = jsonencode({
    Statement = [{ Effect = "Allow", Action = ["SQS:receivemessage"], Resource = "arn:aws:sqs:eu-west-2:123456789012:appointment-*" }]
  })
}

resource "aws_iam_role" "reminder_worker_task" {
  name                = "reminder-worker-task"
  managed_policy_arns = [aws_iam_policy.consume.arn]
}
`,
    });
    const queues = deriveQueues(config, chairside());
    expect(queues.map(({ id, grants }) => [id, grants.map((grant) => [grant.policy.address, grant.actions])])).toEqual([
      ["appointmentEvents->eventConsumer", [["aws_iam_policy.consume", ["SQS:receivemessage"]]]],
      ["eventPublisher->appointmentEvents", [["aws_iam_role.booking_api_task", ["sqs:Send*"]]]],
    ]);
  });

  it("ignores Deny statements, NotAction, other actions and other queues", () => {
    const config = repo({
      "roles.tf": roles,
      "services.tf": `${services}\nresource "aws_sqs_queue" "dead_letters" {\n  name = "dead-letters"\n}\n`,
      "iam.tf": `
resource "aws_iam_role_policy" "booking_api" {
  role = aws_iam_role.booking_api_task.id
  policy = jsonencode({
    Statement = [
      { Effect = "Deny", Action = "sqs:SendMessage", Resource = aws_sqs_queue.appointment_events.arn },
      { Effect = "Allow", NotAction = "sqs:DeleteQueue", Resource = aws_sqs_queue.appointment_events.arn },
      { Effect = "Allow", Action = "sqs:GetQueueAttributes", Resource = aws_sqs_queue.appointment_events.arn },
      { Effect = "Allow", Action = "sqs:SendMessage", Resource = aws_sqs_queue.dead_letters.arn },
    ]
  })
}
`,
    });
    const target = chairside();
    target.elements.set("deadLetters", element("deadLetters", "container", "chairside", { technology: "SQS" }));
    target.elements.get("deadLetters")!.properties["bearing.terraform"] = "aws_sqs_queue.dead_letters";
    target.elements.get("appointmentEvents")!.properties["bearing.terraform"] = "aws_sqs_queue.appointment_events";
    expect(ids(deriveQueues(config, target))).toEqual(["bookingApi->deadLetters"]);
  });

  it("keeps the address of a queue no target element stands for", () => {
    const config = repo({
      "roles.tf": roles,
      "services.tf": `${services}\nresource "aws_sqs_queue" "audit" {}\n`,
      "iam.tf": `
resource "aws_iam_role_policy" "booking_api" {
  role   = aws_iam_role.booking_api_task.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "sqs:SendMessage", Resource = "*" }] })
}
`,
    });
    // Two queues and one queue element: neither is pinned, so neither matches by technology.
    expect(ids(deriveQueues(config, chairside()))).toEqual([
      "bookingApi->aws_sqs_queue.appointment_events",
      "bookingApi->aws_sqs_queue.audit",
    ]);
  });

  it("follows a Lambda function's role", () => {
    const config = repo({
      "main.tf": `
resource "aws_sqs_queue" "appointment_events" {}
resource "aws_iam_role" "worker" {}
resource "aws_lambda_function" "worker" {
  function_name = "worker"
  role          = aws_iam_role.worker.arn
}
resource "aws_iam_role_policy" "worker" {
  role   = aws_iam_role.worker.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "sqs:ReceiveMessage", Resource = aws_sqs_queue.appointment_events.arn }] })
}
`,
    });
    const target = chairside();
    target.deployment.set("lambda", node("lambda", "AWS Lambda", { parent: "aws" }));
    target.deployment.set("lambda/reminderWorker", {
      ...node("lambda/reminderWorker", "", { parent: "lambda", element: "reminderWorker" }),
      type: "containerInstance",
    });
    expect(ids(deriveQueues(config, target))).toEqual(["appointmentEvents->eventConsumer"]);
  });
});

describe("checkClaim with queues", () => {
  it("wants a new grant claimed, and a removed relationship's grant gone", () => {
    const config = repo({ "services.tf": services, "roles.tf": roles, "iam.tf": iam });
    const target = chairside();
    const queues = deriveQueues(config, target);
    const forked = chairside([["appointmentEvents", "eventConsumer"]]);
    const graph = { components: [], relationships: [], unmapped: [] };
    const claim = (added: string[], removed: string[]) => ({
      branch: "3-sms-reminder",
      issues: ["#3"],
      model: { added, removed },
      files: [],
      note: "",
    });
    expect(
      checkClaim(claim([], ["appointmentEvents->eventConsumer"]), { forked, target, graph, changed: [], queues }).map(
        ({ kind, ...rest }) => [kind, "id" in rest ? rest.id : undefined],
      ),
    ).toEqual([
      ["not-removed", "appointmentEvents->eventConsumer"],
      ["unclaimed", "eventPublisher->appointmentEvents"],
    ]);
    expect(
      checkClaim(claim(["eventPublisher->appointmentEvents"], []), { forked, target, graph, changed: [], queues }),
    ).toEqual([]);
  });
});
