import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChecks } from "../src/check.js";
import { loadConfig, parseConfig } from "../src/config.js";
import { readTestRecords } from "../src/coverage.js";
import { deriveImports, DeriveError } from "../src/derive.js";
import { TraceHookError } from "../src/lang/adapter.js";
import { python } from "../src/lang/python.js";
import { modelFromWorkspace } from "../src/model.js";
import { componentPaths } from "../src/paths.js";
import { checkSurplus } from "../src/surplus.js";
import { readSpanRecords, runTraced, tracesDir, type SpanRecord } from "../src/test.js";
import { git } from "./basket.js";
import { bookingDir, bookingRepo, copyBooking, hasPython, pytestCommand } from "./booking.js";

const target = modelFromWorkspace(JSON.parse(readFileSync(join(bookingDir, "workspace.json"), "utf8")));
const components = componentPaths(target);
const quiet = { stdio: "ignore" } as const;
const slow = { timeout: 60_000 };

// Each span as "<component>.<function>", indented under its parent, in the order the calls started.
function callTree(spans: SpanRecord[]): string[] {
  const sorted = [...spans].sort((a, b) => (a.start < b.start ? -1 : 1));
  const byId = new Map(sorted.map((span) => [span.spanId, span]));
  const depth = (span: SpanRecord): number => {
    const parent = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
    return parent === undefined ? 0 : depth(parent) + 1;
  };
  return sorted.map((span) => `${"  ".repeat(depth(span))}${span.component}.${span.name}`);
}

async function traced(root: string, command = [pytestCommand], env: NodeJS.ProcessEnv = {}) {
  const result = await runTraced(loadConfig(root), components, command, { ...quiet, env });
  const dir = join(root, tracesDir);
  return { result, spans: readSpanRecords(dir), tests: readTestRecords(dir) };
}

// A repo of Python files, with a config listing one Python project at `root`.
function pythonRepo(files: Record<string, string>, root = "."): string {
  const repo = mkdtempSync(join(tmpdir(), "bearing-python-"));
  const all = {
    ".bearing/config.yaml": `version: 1\nmodel: m.json\nlanguages:\n  - name: python\n    root: ${root}\n`,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

function extract(repo: string, paths: Record<string, string>) {
  const config = parseConfig(readFileSync(join(repo, ".bearing", "config.yaml"), "utf8"), repo);
  const ids = Object.entries(paths)
    .map(([id, path]) => ({ id, path }))
    .sort((a, b) => b.path.length - a.path.length);
  return python.extractImports(repo, config.languages[0]!, ids);
}

describe.skipIf(!hasPython)("the Python adapter", () => {
  describe("extractImports", () => {
    it("maps each module to its component and each import between components", slow, () => {
      const graph = deriveImports(loadConfig(copyBooking()), target);
      expect(graph.components.map(({ id, files }) => [id, files])).toEqual([
        ["appointmentRepository", ["app/repository/__init__.py", "app/repository/store.py"]],
        ["availabilityService", ["app/availability/__init__.py", "app/availability/service.py"]],
        ["bookingRoutes", ["app/routes/__init__.py", "app/routes/api.py"]],
        ["bookingService", ["app/booking/__init__.py", "app/booking/service.py"]],
      ]);
      expect(graph.relationships.map(({ id, imports }) => [id, imports])).toEqual([
        [
          "availabilityService->appointmentRepository",
          [{ file: "app/availability/service.py", line: 5, module: "app.repository" }],
        ],
        ["bookingRoutes->availabilityService", [{ file: "app/routes/api.py", line: 8, module: "app.availability" }]],
        ["bookingRoutes->bookingService", [{ file: "app/routes/api.py", line: 9, module: "app.booking" }]],
        [
          "bookingService->appointmentRepository",
          [{ file: "app/booking/service.py", line: 6, module: "app.repository" }],
        ],
        [
          "bookingService->availabilityService",
          [{ file: "app/booking/service.py", line: 5, module: "app.availability" }],
        ],
      ]);
      // app/__init__.py is outside every component, but holds only a docstring.
      expect(graph.unmapped).toEqual([]);
    });

    it("follows re-exports to the component declaring what an import uses", () => {
      const repo = pythonRepo({
        "pyproject.toml": '[tool.setuptools.packages.find]\nwhere = ["src"]\n',
        "src/shop/__init__.py": "",
        "src/shop/api/views.py": [
          "from shop.common import price, Basket",
          "from ..orders import submit",
          "from . import helpers",
          "import shop.orders.store as store",
          "import requests",
          "def handler():",
          "    from shop.common import *",
          '    importlib.import_module("shop.orders.store")',
        ].join("\n"),
        "src/shop/api/helpers.py": "",
        // A shared package outside every component, re-exporting from two of them.
        "src/shop/common/__init__.py": "from shop.pricing.rules import price\nfrom .models import *\n",
        "src/shop/common/models.py": "from shop.orders.basket import Basket\n",
        "src/shop/pricing/rules.py": "def price(): ...\n",
        "src/shop/orders/__init__.py": "def submit(): ...\n",
        "src/shop/orders/basket.py": "class Basket: ...\n",
        "src/shop/orders/store.py": "",
        "src/shop/orders/test_store.py": "from shop.api.views import handler\n",
      });
      const { files, imports } = extract(repo, {
        api: "src/shop/api",
        pricing: "src/shop/pricing",
        orders: "src/shop/orders",
      });
      expect(files).not.toContain("src/shop/orders/test_store.py");
      expect(imports).toEqual([
        { file: "src/shop/api/views.py", line: 1, module: "shop.common", destination: "orders" },
        { file: "src/shop/api/views.py", line: 1, module: "shop.common", destination: "pricing" },
        { file: "src/shop/api/views.py", line: 2, module: "..orders", destination: "orders" },
        { file: "src/shop/api/views.py", line: 4, module: "shop.orders.store", destination: "orders" },
        { file: "src/shop/api/views.py", line: 8, module: "shop.orders.store", destination: "orders" },
      ]);
    });

    it("reads a project below the repo root, leaving out files outside every component", slow, () => {
      const root = copyBooking();
      const service = join(root, "services", "booking-api");
      for (const path of ["pyproject.toml", "app", "tests"]) {
        cpSync(join(root, path), join(service, path), { recursive: true });
        rmSync(join(root, path), { recursive: true });
      }
      writeFileSync(join(service, "main.py"), "from app.routes import create_app\n");
      const config = join(root, ".bearing", "config.yaml");
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace(
          "  - name: python\n",
          "  - name: python\n    root: services/booking-api\n",
        ),
      );
      const moved = modelFromWorkspace(
        JSON.parse(
          readFileSync(join(bookingDir, "workspace.json"), "utf8").replaceAll('"app/', '"services/booking-api/app/'),
        ),
      );
      const graph = deriveImports(loadConfig(root), moved);
      expect(graph.relationships.map((relationship) => relationship.id)).toEqual([
        "availabilityService->appointmentRepository",
        "bookingRoutes->availabilityService",
        "bookingRoutes->bookingService",
        "bookingService->appointmentRepository",
        "bookingService->availabilityService",
      ]);
      expect(graph.unmapped).toEqual(["services/booking-api/main.py"]);
    });

    it("leaves out files with no code, virtual environments and hidden folders", () => {
      const repo = pythonRepo({
        "pyproject.toml": "",
        "app/__init__.py": '"""The app."""\n',
        "app/a.py": "x = 1\n",
        ".venv/pyvenv.cfg": "",
        ".venv/lib/x.py": "",
        "env/pyvenv.cfg": "",
        "env/lib/y.py": "",
        "app/__pycache__/a.py": "",
      });
      expect(extract(repo, {}).files).toEqual(["app/a.py"]);
    });

    it("names the config key when pyproject.toml is missing", () => {
      const root = copyBooking();
      rmSync(join(root, "pyproject.toml"));
      expect(() => deriveImports(loadConfig(root), target)).toThrow(
        new DeriveError("pyproject.toml not found; check the Python project file in .bearing/config.yaml"),
      );
    });

    it("says what's wrong with a broken pyproject.toml", () => {
      const root = copyBooking();
      writeFileSync(join(root, "pyproject.toml"), "[tool.pytest\n");
      expect(() => deriveImports(loadConfig(root), target)).toThrow(/^pyproject\.toml: .+/);
    });
  });

  describe("tracedFunctions", () => {
    const traced = (code: string) => python.traceHook.tracedFunctions(code, "x.py");

    it("lists public functions and the public methods of public classes", () => {
      expect(
        traced(
          [
            "from typing import Protocol, overload",
            "from abc import ABC, abstractmethod",
            "def book(): ...",
            "async def list_slots(): ...",
            "def _helper(): ...",
            "class Service:",
            "    def __init__(self): ...",
            "    def reserve(self): ...",
            "    @staticmethod",
            "    def parse(): ...",
            "    @property",
            "    def size(self): ...",
            "    def _grow(self): ...",
            "    @abstractmethod",
            "    def run(self): ...",
            "class _Inner:",
            "    def visible(self): ...",
            "class Port(Protocol):",
            "    def send(self): ...",
            "@overload",
            "def get(x: int) -> int: ...",
            "def get(x): ...",
            "if True:",
            "    def hidden(): ...",
          ].join("\n"),
        ),
      ).toEqual(["Service.parse", "Service.reserve", "Service.size", "book", "get", "list_slots"]);
    });

    it("lists nothing in a file that doesn't parse", () => {
      expect(traced("def broken(:\n")).toEqual([]);
    });
  });

  describe("bearing test", () => {
    it("traces the tests, tagged with their markers, without touching the working tree", slow, async () => {
      const root = bookingRepo();
      const { result, spans, tests } = await traced(root);
      expect(result).toEqual({
        exitCode: 0,
        spans: spans.length,
        criteria: ["#1/AC1", "#1/AC2", "#5/AC1", "#5/AC2"],
        warnings: [],
      });
      expect(tests.map(({ name, file, status, criterion }) => [name, file, status, criterion])).toEqual([
        ["tests/test_booking.py::test_lists_every_open_slot", "tests/test_booking.py", "passed", "#1/AC1"],
        ["tests/test_booking.py::test_confirms_a_booking", "tests/test_booking.py", "passed", "#1/AC2"],
        ["tests/test_booking.py::test_refuses_a_slot_already_booked", "tests/test_booking.py", "passed", "#5/AC1"],
        ["tests/test_booking.py::test_the_first_patient_keeps_the_slot", "tests/test_booking.py", "passed", "#5/AC2"],
        ["tests/test_slots.py::test_a_booked_slot_is_not_free", "tests/test_slots.py", "passed", undefined],
        ["tests/test_slots.py::test_skipped", "tests/test_slots.py", "skipped", undefined],
      ]);
      // FastAPI runs the sync route in a worker thread and the async one on the event loop; both nest their calls.
      expect(callTree(spans.filter((span) => span.criterion === "#1/AC2"))).toEqual([
        "bookingRoutes.create_app",
        "bookingRoutes.book",
        "  bookingService.BookingService.book",
        "    availabilityService.AvailabilityService.reserve",
        "      appointmentRepository.AppointmentRepository.insert",
        "bookingRoutes.get_appointment",
        "  bookingService.BookingService.get",
        "    appointmentRepository.AppointmentRepository.get",
      ]);
      expect(callTree(spans.filter((span) => span.criterion === "#1/AC1"))).toEqual([
        "bookingRoutes.create_app",
        "bookingRoutes.list_slots",
        "  availabilityService.AvailabilityService.free_slots",
        "    appointmentRepository.AppointmentRepository.booked_slot_ids",
        "    appointmentRepository.AppointmentRepository.slots",
      ]);
      expect(spans.find((span) => span.name === "AvailabilityService.reserve")).toMatchObject({
        file: "app/availability/service.py",
        test: "tests/test_booking.py::test_confirms_a_booking",
      });
      // The unit test's calls are traced too, but carry no criterion.
      const unit = spans.filter((span) => span.test === "tests/test_slots.py::test_a_booked_slot_is_not_free");
      expect(unit.length).toBeGreaterThan(0);
      expect(unit.every((span) => span.criterion === undefined)).toBe(true);
      // No instrumented bytecode is cached for a run without the hook to load.
      expect(existsSync(join(root, "app", "routes", "__pycache__"))).toBe(false);
      expect(git(root, "status", "--porcelain")).toBe("");
    });

    it("keeps tracebacks pointing at the original lines", slow, async () => {
      const root = copyBooking();
      const file = join(root, "app", "availability", "service.py");
      writeFileSync(file, readFileSync(file, "utf8").replace("booked = self", "1 / 0\n        booked = self"));
      const { result } = await traced(root, [`${pytestCommand} --tb=short tests/test_slots.py > out.txt`]);
      expect(result.exitCode).not.toBe(0);
      const line =
        readFileSync(file, "utf8")
          .split("\n")
          .findIndex((text) => text.includes("1 / 0")) + 1;
      expect(readFileSync(join(root, "out.txt"), "utf8")).toContain(
        `app/availability/service.py:${line}: in free_slots`,
      );
    });

    it("records a test whose teardown fails as failed, and a marker on its class", slow, async () => {
      const root = copyBooking();
      writeFileSync(
        join(root, "tests", "test_more.py"),
        [
          "import pytest",
          "",
          "@pytest.fixture",
          "def broken():",
          "    yield",
          "    raise RuntimeError('teardown')",
          "",
          '@pytest.mark.req("#5/AC1")',
          "class TestTagged:",
          "    def test_one(self, broken):",
          "        pass",
          "",
          '@pytest.mark.req("not a tag")',
          "def test_mistagged():",
          "    pass",
        ].join("\n"),
      );
      const { tests } = await traced(root, [`${pytestCommand} tests/test_more.py`]);
      expect(tests.map(({ name, status, criterion }) => [name, status, criterion])).toEqual([
        ["tests/test_more.py::TestTagged::test_one", "failed", "#5/AC1"],
        ["tests/test_more.py::test_mistagged", "passed", undefined],
      ]);
    });

    it("carries the trace through SQS messages sent and received with botocore", slow, async () => {
      // A stand-in for botocore's client: an in-memory queue that, like SQS, returns only the attributes asked for.
      const botocore = `
QUEUE = []


class _ServiceModel:
    service_name = "sqs"


class _Meta:
    service_model = _ServiceModel()


class BaseClient:
    meta = _Meta()

    def _make_api_call(self, operation_name, api_params):
        if operation_name == "SendMessage":
            QUEUE.append(api_params)
            return {"MessageId": str(len(QUEUE))}
        names = api_params.get("MessageAttributeNames", [])
        messages = []
        while QUEUE:
            sent = QUEUE.pop(0)
            attributes = {k: v for k, v in sent.get("MessageAttributes", {}).items() if k in names}
            message = {"Body": sent["MessageBody"]}
            if attributes:
                message.update(MessageAttributes=attributes, MD5OfMessageAttributes="md5")
            messages.append(message)
        return {"Messages": messages}

    def send_message(self, **params):
        return self._make_api_call("SendMessage", params)

    def receive_message(self, **params):
        return self._make_api_call("ReceiveMessage", params)
`;
      const url = "http://localhost:4566/000000000000/appointment-events";
      const root = pythonRepo({
        "pyproject.toml": '[tool.pytest.ini_options]\npythonpath = [".", "stubs"]\ntestpaths = ["tests"]\n',
        "stubs/botocore/__init__.py": "",
        "stubs/botocore/client.py": botocore,
        "app/__init__.py": "",
        "app/events/__init__.py": [
          "from botocore.client import BaseClient",
          "",
          "",
          "def publish(kind):",
          `    attributes = {"type": {"DataType": "String", "StringValue": kind}}`,
          `    return BaseClient().send_message(QueueUrl="${url}", MessageBody="{}", MessageAttributes=attributes)`,
          "",
        ].join("\n"),
        "app/consumer/__init__.py": [
          "from botocore.client import BaseClient",
          "",
          "from app.schedule import schedule",
          "",
          "",
          "def poll():",
          `    received = BaseClient().receive_message(QueueUrl="${url}")`,
          '    for message in received["Messages"]:',
          '        schedule(message["Body"])',
          "    return received",
          "",
        ].join("\n"),
        "app/schedule/__init__.py": "def schedule(body):\n    return body\n",
        "tests/test_queue.py": [
          "import pytest",
          "",
          "from app.consumer import poll",
          "from app.events import publish",
          "",
          "",
          '@pytest.mark.req("#3/AC1")',
          "def test_books():",
          '    publish("appointment.confirmed")',
          "",
          "",
          "def test_worker_picks_it_up():",
          "    received = poll()",
          '    assert received["Messages"] == [{"Body": "{}"}]',
          "",
        ].join("\n"),
      });
      const config = loadConfig(root);
      const queueComponents = [
        { id: "eventPublisher", path: "app/events" },
        { id: "eventConsumer", path: "app/consumer" },
        { id: "scheduler", path: "app/schedule" },
      ];
      const result = await runTraced(config, queueComponents, [pytestCommand], quiet);
      expect(result.exitCode).toBe(0);
      const spans = readSpanRecords(join(root, tracesDir));
      // The worker's calls are another test's, but they carry on the trace of the test that sent the message.
      const sender = spans.filter((span) => span.test === "tests/test_queue.py::test_books");
      expect(new Set(sender.map((span) => span.traceId)).size).toBe(1);
      expect(sender.every((span) => span.criterion === "#3/AC1")).toBe(true);
      expect(callTree(sender).map((line) => line.replace(/\.$/, ""))).toEqual([
        "eventPublisher.publish",
        "  .send appointment-events",
        "    .receive appointment-events",
        "      eventConsumer.poll",
        "        scheduler.schedule",
      ]);
      expect(
        sender.filter((span) => span.queue !== undefined).map(({ queue, operation }) => [queue, operation]),
      ).toEqual([
        ["appointment-events", "send"],
        ["appointment-events", "receive"],
      ]);
      // poll() itself started in the receiving test's trace, before the message came in.
      expect(
        spans.filter((span) => span.test === "tests/test_queue.py::test_worker_picks_it_up").map((span) => span.name),
      ).toEqual(["poll"]);
    });

    it("records the HTTP requests sent with requests and httpx, sync and async", slow, async () => {
      // Stand-ins for requests and httpx: just enough of each to send a request through the method the hook patches.
      const sessions = `
class PreparedRequest:
    def __init__(self, method, url):
        self.method = method
        self.url = url


class Session:
    def get(self, url):
        return self.send(PreparedRequest("GET", url))

    def send(self, request, **kwargs):
        return {"status": 200, "url": request.url}
`;
      const httpx = `
class URL:
    def __init__(self, url):
        self._url = url

    def __str__(self):
        return self._url


class Request:
    def __init__(self, method, url):
        self.method = method
        self.url = URL(url)


class Client:
    def post(self, url):
        return self.send(Request("post", url))

    def send(self, request, **kwargs):
        return str(request.url)


class AsyncClient:
    async def get(self, url):
        return await self.send(Request("GET", url))

    async def send(self, request, **kwargs):
        return str(request.url)
`;
      const root = pythonRepo({
        "pyproject.toml": '[tool.pytest.ini_options]\npythonpath = [".", "stubs"]\ntestpaths = ["tests"]\n',
        "stubs/requests/__init__.py":
          "from .sessions import Session\n\n\ndef get(url):\n    return Session().get(url)\n",
        "stubs/requests/sessions.py": sessions,
        "stubs/httpx/__init__.py": httpx,
        "app/__init__.py": "",
        "app/client/__init__.py": [
          "import asyncio",
          "",
          "import httpx",
          "import requests",
          "",
          "",
          "def list_slots():",
          '    return requests.get("http://booking-api:8000/slots")',
          "",
          "",
          "def book():",
          '    return httpx.Client().post("http://booking-api.chairside.svc.cluster.local/bookings")',
          "",
          "",
          "def remind():",
          '    return asyncio.run(httpx.AsyncClient().get("https://notifier/reminders"))',
          "",
        ].join("\n"),
        "tests/test_client.py": [
          "import pytest",
          "",
          "from app.client import book, list_slots, remind",
          "",
          "",
          '@pytest.mark.req("#1/AC1")',
          "def test_books_a_slot():",
          '    assert list_slots() == {"status": 200, "url": "http://booking-api:8000/slots"}',
          "    book()",
          '    assert remind() == "https://notifier/reminders"',
          "",
        ].join("\n"),
      });
      const result = await runTraced(
        loadConfig(root),
        [{ id: "bookingClient", path: "app/client" }],
        [pytestCommand],
        quiet,
      );
      expect(result.exitCode).toBe(0);
      const spans = readSpanRecords(join(root, tracesDir));
      expect(spans.every((span) => span.test === "tests/test_client.py::test_books_a_slot")).toBe(true);
      expect(spans.every((span) => span.criterion === "#1/AC1")).toBe(true);
      expect(callTree(spans)).toEqual([
        "bookingClient.list_slots",
        "  .GET booking-api",
        "bookingClient.book",
        "  .POST booking-api.chairside.svc.cluster.local",
        "bookingClient.remind",
        "  .GET notifier",
      ]);
      expect(spans.flatMap((span) => (span.http === undefined ? [] : [span.http]))).toEqual([
        { method: "GET", host: "booking-api", port: 8000 },
        { method: "POST", host: "booking-api.chairside.svc.cluster.local" },
        { method: "GET", host: "notifier" },
      ]);
    });

    it("refuses a PYTEST_PLUGINS that already loads Bearing's plugin", () => {
      return expect(
        traced(copyBooking(), [pytestCommand], { PYTEST_PLUGINS: "xdist,bearing_python.pytest_plugin" }),
      ).rejects.toThrow(
        new TraceHookError("PYTEST_PLUGINS already loads bearing_python.pytest_plugin; leave it to bearing test"),
      );
    });
  });

  describe("the checks on real traces", () => {
    beforeEach(() => vi.stubEnv("BEARING_ISSUES_FILE", join(bookingDir, "issues.json")));
    afterEach(() => vi.unstubAllEnvs());

    const statuses = async (root: string) => {
      await traced(root);
      const report = await runChecks(loadConfig(root));
      return Object.fromEntries(report.checks.map((check) => [check.check, check.status]));
    };
    const passing = {
      valid: "passed",
      target: "skipped",
      claim: "passed",
      boundaries: "passed",
      deployment: "skipped",
      coverage: "passed",
      paths: "passed",
      surplus: "passed",
    };

    it.each([
      ["slot-labels", passing],
      ["routes-read-repository", { ...passing, claim: "failed", boundaries: "failed", paths: "failed" }],
      ["slot-check-in-route", { ...passing, paths: "failed" }],
      ["untraced-helper", { ...passing, surplus: "flagged" }],
    ] as const)("%s", slow, async (variant, expected) => {
      expect(await statuses(bookingRepo(variant))).toEqual(expected);
    });

    it("flags the helper untraced-helper adds and nothing else", slow, async () => {
      const root = bookingRepo("untraced-helper");
      const { spans } = await traced(root);
      const config = loadConfig(root);
      expect(checkSurplus(config, deriveImports(config, target), spans).untraced).toEqual([
        {
          file: "app/availability/service.py",
          component: "availabilityService",
          functions: ["AvailabilityService.nearest_free_slots"],
        },
      ]);
    });
  });
});
