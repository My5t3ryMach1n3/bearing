import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChecks } from "../src/check.js";
import { loadConfig } from "../src/config.js";
import { readTestRecords } from "../src/coverage.js";
import { deriveImports, DeriveError } from "../src/derive.js";
import { TraceHookError } from "../src/lang/adapter.js";
import { go } from "../src/lang/go.js";
import { modelFromWorkspace } from "../src/model.js";
import { componentPaths } from "../src/paths.js";
import { checkSurplus } from "../src/surplus.js";
import { readSpanRecords, runTraced, tracesDir, type SpanRecord } from "../src/test.js";
import { git } from "./basket.js";
import { copyReminders, hasGo, remindersDir, remindersRepo } from "./reminders.js";

const target = modelFromWorkspace(JSON.parse(readFileSync(join(remindersDir, "workspace.json"), "utf8")));
const components = componentPaths(target);
const quiet = { stdio: "ignore" } as const;
// The first Go test builds Bearing's helper and the tests' standard library with the trace hook's runtime file.
const slow = { timeout: 180_000 };

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

async function traced(root: string, command = ["go test ./..."], env: NodeJS.ProcessEnv = {}) {
  const result = await runTraced(loadConfig(root), components, command, { ...quiet, env });
  const dir = join(root, tracesDir);
  return { result, spans: readSpanRecords(dir), tests: readTestRecords(dir) };
}

describe.skipIf(!hasGo)("the Go adapter", () => {
  describe("extractImports", () => {
    it("maps each package to its component and each import between components", slow, () => {
      const root = copyReminders();
      const graph = deriveImports(loadConfig(root), target);
      expect(graph.components.map(({ id, files }) => [id, files])).toEqual([
        ["eventConsumer", ["internal/consumer/consumer.go"]],
        ["reminderStore", ["internal/store/store.go"]],
        ["scheduler", ["internal/schedule/scheduler.go"]],
        ["smsSender", ["internal/sms/sender.go", "internal/sms/templates.go"]],
      ]);
      expect(graph.relationships.map(({ id, imports }) => [id, imports])).toEqual([
        [
          "eventConsumer->scheduler",
          [
            {
              file: "internal/consumer/consumer.go",
              line: 8,
              module: "chairside.example/reminder-worker/internal/schedule",
            },
          ],
        ],
        [
          "scheduler->reminderStore",
          [
            {
              file: "internal/schedule/scheduler.go",
              line: 9,
              module: "chairside.example/reminder-worker/internal/store",
            },
          ],
        ],
        [
          "scheduler->smsSender",
          [
            {
              file: "internal/schedule/scheduler.go",
              line: 8,
              module: "chairside.example/reminder-worker/internal/sms",
            },
          ],
        ],
      ]);
      expect(graph.unmapped).toEqual([]);
    });

    it("reads a module below the repo root, leaving out files outside every component", slow, () => {
      const root = copyReminders();
      const service = join(root, "services", "reminder-worker");
      for (const path of ["go.mod", "internal", "integration"]) {
        cpSync(join(root, path), join(service, path), { recursive: true });
        rmSync(join(root, path), { recursive: true });
      }
      mkdirSync(join(service, "cmd", "worker"), { recursive: true });
      writeFileSync(join(service, "cmd", "worker", "main.go"), "package main\n\nfunc main() {}\n");
      const config = join(root, ".bearing", "config.yaml");
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace("  - name: go\n", "  - name: go\n    root: services/reminder-worker\n"),
      );
      const moved = modelFromWorkspace(
        JSON.parse(
          readFileSync(join(remindersDir, "workspace.json"), "utf8").replaceAll(
            '"internal/',
            '"services/reminder-worker/internal/',
          ),
        ),
      );
      const graph = deriveImports(loadConfig(root), moved);
      expect(graph.relationships.map((relationship) => relationship.id)).toEqual([
        "eventConsumer->scheduler",
        "scheduler->reminderStore",
        "scheduler->smsSender",
      ]);
      expect(graph.unmapped).toEqual(["services/reminder-worker/cmd/worker/main.go"]);
    });

    it("names the config key when go.mod is missing", () => {
      const root = copyReminders();
      rmSync(join(root, "go.mod"));
      expect(() => deriveImports(loadConfig(root), target)).toThrow(
        new DeriveError("go.mod not found; check the Go project file in .bearing/config.yaml"),
      );
    });
  });

  describe("tracedFunctions", () => {
    const traced = (code: string) => go.traceHook.tracedFunctions(code, "x.go");

    it("lists exported functions and the exported methods of exported types", slow, () => {
      expect(
        traced(
          [
            "package x",
            "func New() *Set[int] { return nil }",
            "func helper() {}",
            "type Set[T comparable] struct{}",
            "func (s *Set[T]) Add(v T) {}",
            "func (Set[T]) Len() int { return 0 }",
            "func (s *Set[T]) grow() {}",
            "type inner struct{}",
            "func (inner) Exported() {}",
            "//go:noescape",
            "func Assembly()",
          ].join("\n"),
        ),
      ).toEqual(["New", "Set.Add", "Set.Len"]);
    });

    it("lists nothing in a file that doesn't parse", slow, () => {
      expect(traced("package x\nfunc Broken( {")).toEqual([]);
    });
  });

  describe("bearing test", () => {
    it("traces the subtests, tagged with their criteria, without touching the working tree", slow, async () => {
      const root = remindersRepo();
      const { result, spans, tests } = await traced(root);
      expect(result).toEqual({
        exitCode: 0,
        spans: spans.length,
        criteria: ["#3/AC1", "#3/AC2", "#3/AC3"],
        warnings: [],
      });
      expect(tests.map(({ name, status, criterion }) => [name, status, criterion])).toEqual(
        expect.arrayContaining([
          ["TestReminders/#3/AC1_sends_an_SMS_24_hours_before_the_appointment", "passed", "#3/AC1"],
          ["TestReminders/#3/AC2_waits_until_24_hours_before", "passed", "#3/AC2"],
          ["TestReminders/#3/AC3_sends_each_reminder_once", "passed", "#3/AC3"],
          ["TestReminders", "passed", undefined],
          ["TestFormat", "passed", undefined],
          ["TestSkipped", "skipped", undefined],
        ]),
      );
      expect(tests).toHaveLength(6);
      // Arguments are called first. The consumer polls in a goroutine of its own, which joins the test's trace beside
      // Run or under it, depending on whether Run has returned by then.
      const ac1 = spans.filter((span) => span.criterion === "#3/AC1");
      const tree = callTree(ac1);
      expect(tree.slice(0, 5)).toEqual([
        "smsSender.NewSender",
        "reminderStore.New",
        "scheduler.New",
        "eventConsumer.New",
        "eventConsumer.Consumer.Run",
      ]);
      const schedule = tree.findIndex((line) => line.trim() === "scheduler.Scheduler.Schedule");
      expect(tree[schedule - 1]!.trim()).toBe("eventConsumer.Consumer.Poll");
      expect(tree.slice(-5)).toEqual([
        "scheduler.Scheduler.RunDue",
        "  reminderStore.Store.WasSent",
        "  smsSender.Sender.Send",
        "    smsSender.Format",
        "  reminderStore.Store.MarkSent",
      ]);
      expect(ac1.find((span) => span.name === "Sender.Send")).toMatchObject({
        file: "internal/sms/sender.go",
        test: "TestReminders/#3/AC1_sends_an_SMS_24_hours_before_the_appointment",
      });
      // The unit test's calls are traced too, but carry no criterion.
      expect(spans.filter((span) => span.test === "TestFormat").map((span) => span.criterion)).toEqual([undefined]);
      expect(git(root, "status", "--porcelain")).toBe("");
    });

    it("records the HTTP requests a component's http.Client sends", slow, async () => {
      const root = copyReminders();
      writeFileSync(
        join(root, "internal", "sms", "booking.go"),
        [
          "package sms",
          "",
          'import (\n\t"io"\n\t"net/http"\n\t"strings"\n)',
          "",
          "// answer stands in for the network.",
          "type answer struct{}",
          "",
          "func (answer) RoundTrip(r *http.Request) (*http.Response, error) {",
          '\treturn &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil',
          "}",
          "",
          "var client = &http.Client{Transport: answer{}}",
          "",
          "func Confirm() error {",
          '\tresp, err := client.Get("http://booking-api:8000/appointments/1")',
          "\tif err == nil {\n\t\tresp.Body.Close()\n\t}",
          "\treturn err",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "internal", "sms", "booking_test.go"),
        [
          "package sms",
          "",
          'import "testing"',
          "",
          "func TestConfirm(t *testing.T) {",
          '\tt.Run("#3/AC1 confirms the appointment", func(t *testing.T) {',
          "\t\tif err := Confirm(); err != nil {\n\t\t\tt.Fatal(err)\n\t\t}",
          "\t})",
          "}",
          "",
        ].join("\n"),
      );
      const { result, spans } = await traced(root, ["go test ./internal/sms"]);
      expect(result.exitCode).toBe(0);
      const confirm = spans.filter((span) => span.test === "TestConfirm/#3/AC1_confirms_the_appointment");
      expect(callTree(confirm)).toEqual(["smsSender.Confirm", "  .GET booking-api"]);
      expect(confirm.find((span) => span.http !== undefined)).toMatchObject({
        criterion: "#3/AC1",
        http: { method: "GET", host: "booking-api", port: 8000 },
      });
    });

    it("traces every run, rather than replaying the go command's cached results", slow, async () => {
      const root = copyReminders();
      await traced(root);
      const { spans } = await traced(root);
      expect(spans.filter((span) => span.criterion === "#3/AC3").length).toBeGreaterThan(0);
    });

    // Which packages go untraced depends on the Go release: since 1.22, -cover ./... covers packages with no tests of
    // their own too, such as the scheduler.
    it("warns that packages Go's coverage covers go untraced", slow, async () => {
      const { result } = await traced(copyReminders(), ["go test -cover ./..."]);
      expect(result.warnings).toEqual([expect.stringContaining("run `bearing test` without -cover or -coverpkg")]);
    });

    it("keeps positions in compile errors pointing at the original file", slow, async () => {
      const root = copyReminders();
      const file = join(root, "internal", "store", "store.go");
      writeFileSync(file, readFileSync(file, "utf8").replace("return s.sent[appointment]", "return s.sent[missing]"));
      const result = await runTraced(loadConfig(root), components, ["go vet ./internal/store 2> vet.txt"], quiet);
      expect(result.exitCode).not.toBe(0);
      const line =
        readFileSync(file, "utf8")
          .split("\n")
          .findIndex((text) => text.includes("missing")) + 1;
      expect(readFileSync(join(root, "vet.txt"), "utf8")).toContain(`store.go:${line}:16: undefined: missing`);
    });

    it("finds a tag template with a space in it in Go's underscored subtest names", slow, async () => {
      const root = copyReminders();
      const config = join(root, ".bearing", "config.yaml");
      writeFileSync(config, readFileSync(config, "utf8").replace('tag: "#<issue>/AC<n>"', 'tag: "AC<n> of #<issue>"'));
      const test = join(root, "integration", "reminders_test.go");
      writeFileSync(test, readFileSync(test, "utf8").replace('"#3/AC1 sends', '"AC1 of #3 sends'));
      const { tests } = await traced(root);
      expect(tests.find((record) => record.name.includes("AC1_of_#3"))?.criterion).toBe("AC1 of #3");
    });

    it("refuses a GOFLAGS overlay of the test command's own", () => {
      const root = copyReminders();
      return expect(traced(root, ["go test ./..."], { GOFLAGS: "-overlay=mine.json" })).rejects.toThrow(
        new TraceHookError("GOFLAGS already has -overlay; Bearing's Go trace hook needs to set its own"),
      );
    });

    it("says it can't trace a vendored module yet", () => {
      const root = copyReminders();
      mkdirSync(join(root, "vendor"));
      writeFileSync(join(root, "vendor", "modules.txt"), "");
      return expect(traced(root)).rejects.toThrow(
        new TraceHookError(
          "can't trace .: the trace hook doesn't support vendored dependencies yet; run with GOFLAGS=-mod=mod",
        ),
      );
    });
  });

  describe("the checks on real traces", () => {
    beforeEach(() => vi.stubEnv("BEARING_ISSUES_FILE", join(remindersDir, "issues.json")));
    afterEach(() => vi.unstubAllEnvs());

    const statuses = async (root: string) => {
      await traced(root);
      const report = await runChecks(loadConfig(root));
      return Object.fromEntries(report.checks.map((check) => [check.check, check.status]));
    };

    it.each([
      [
        "reminder-text",
        {
          valid: "passed",
          target: "skipped",
          claim: "passed",
          boundaries: "passed",
          deployment: "skipped",
          coverage: "passed",
          paths: "passed",
          surplus: "passed",
        },
      ],
      [
        "consumer-sends-sms",
        {
          valid: "passed",
          target: "skipped",
          claim: "failed",
          boundaries: "failed",
          deployment: "skipped",
          coverage: "passed",
          paths: "failed",
          surplus: "passed",
        },
      ],
      [
        "untraced-format",
        {
          valid: "passed",
          target: "skipped",
          claim: "passed",
          boundaries: "passed",
          deployment: "skipped",
          coverage: "passed",
          paths: "passed",
          surplus: "flagged",
        },
      ],
    ] as const)("%s", slow, async (variant, expected) => {
      expect(await statuses(remindersRepo(variant))).toEqual(expected);
    });

    it("flags the template untraced-format adds and nothing else", slow, async () => {
      const root = remindersRepo("untraced-format");
      const { spans } = await traced(root);
      const config = loadConfig(root);
      expect(checkSurplus(config, deriveImports(config, target), spans).untraced).toEqual([
        { file: "internal/sms/templates.go", component: "smsSender", functions: ["FormatWelsh"] },
      ]);
    });
  });
});
