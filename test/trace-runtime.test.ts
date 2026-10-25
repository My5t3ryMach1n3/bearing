import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTestRecords } from "../src/coverage.js";
import { criterionPattern, installRuntime } from "../src/trace/runtime.js";

// The runtime installs itself once per process; Vitest gives each test file its own.
const dir = mkdtempSync(join(tmpdir(), "bearing-runtime-"));
const runtime = installRuntime({ dir, tag: "#<issue>/AC<n>" });
const service = runtime.module("basketService", "src/basket-service/index.ts");
const repository = runtime.module("basketRepository", "src/basket-repository/index.ts");

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Array<{ key: string; value: { stringValue?: string } }>;
  status: { code: number; message?: string };
}

function spans(): Span[] {
  return readdirSync(dir)
    .filter((file) => file.startsWith("spans-"))
    .flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .trim()
        .split("\n")
        .flatMap(
          (line) =>
            (JSON.parse(line) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> }).resourceSpans[0]!
              .scopeSpans[0]!.spans,
        ),
    );
}

const attribute = (span: Span, key: string) => span.attributes.find((item) => item.key === key)?.value.stringValue;
const named = (name: string) => spans().filter((span) => span.name === name);

describe("trace runtime", () => {
  it("records each test's outcome with the criterion in its name", () => {
    runtime.test({ name: "basket > #2/AC1 adds an item", file: "test/basket.test.ts", status: "passed" });
    runtime.test({ name: "basket > #2 adds without a criterion", status: "failed" });
    expect(readTestRecords(dir)).toEqual([
      { name: "basket > #2/AC1 adds an item", file: "test/basket.test.ts", status: "passed", criterion: "#2/AC1" },
      { name: "basket > #2 adds without a criterion", status: "failed" },
    ]);
  });

  it("#9/AC3 tags each span with its component, function, file, test and criterion", () => {
    service.wrap((n: number) => n + 1, "increment")(1);
    const [span] = named("increment");
    expect(attribute(span!, "bearing.component")).toBe("basketService");
    expect(attribute(span!, "code.function.name")).toBe("increment");
    expect(attribute(span!, "code.file.path")).toBe("src/basket-service/index.ts");
    expect(attribute(span!, "bearing.test")).toBe(
      "trace runtime > #9/AC3 tags each span with its component, function, file, test and criterion",
    );
    expect(attribute(span!, "bearing.criterion")).toBe("#9/AC3");
    expect(span!.status).toEqual({ code: 1 });
  });

  it("leaves the criterion off a test without a tag", () => {
    service.wrap(() => undefined, "untagged")();
    const [span] = named("untagged");
    expect(attribute(span!, "bearing.test")).toBe("trace runtime > leaves the criterion off a test without a tag");
    expect(attribute(span!, "bearing.criterion")).toBeUndefined();
  });

  it("nests calls across components and awaits, within one trace", async () => {
    const save = repository.wrap(async (item: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return item;
    }, "saveBasket");
    const addItem = service.wrap(async (item: string) => save(await Promise.resolve(item)), "addItem");
    expect(await addItem("mug")).toBe("mug");

    const [outer] = named("addItem");
    const [inner] = named("saveBasket");
    expect(inner!.parentSpanId).toBe(outer!.spanId);
    expect(inner!.traceId).toBe(outer!.traceId);
    expect(outer!.parentSpanId).toBeUndefined();
  });

  it("records errors, thrown or rejected, and rethrows them", async () => {
    const fail = service.wrap(() => {
      throw new RangeError("quantity must be positive");
    }, "fail");
    const reject = service.wrap(async () => Promise.reject(new Error("catalogue down")), "reject");
    expect(() => fail()).toThrow("quantity must be positive");
    await expect(reject()).rejects.toThrow("catalogue down");
    expect(named("fail")[0]!.status).toEqual({ code: 2, message: "RangeError: quantity must be positive" });
    expect(named("reject")[0]!.status).toEqual({ code: 2, message: "Error: catalogue down" });
  });

  it("keeps a function's name, length, properties, this and new", () => {
    const original = Object.assign(
      function (this: { base: number } | undefined, a: number, b: number) {
        return (this?.base ?? 0) + a + b;
      },
      { version: 2 },
    );
    const wrapped = service.wrap(original, "sum");
    expect(wrapped.name).toBe(original.name);
    expect(wrapped.length).toBe(2);
    expect(wrapped.version).toBe(2);
    expect(wrapped.call({ base: 10 }, 1, 2)).toBe(13);

    function Point(this: { x: number }, x: number) {
      this.x = x;
    }
    const WrappedPoint = service.wrap(Point, "Point") as unknown as new (x: number) => { x: number };
    const point = new WrappedPoint(3);
    expect(point.x).toBe(3);
    expect(point).toBeInstanceOf(Point);
  });

  it("leaves classes and other values alone, and wraps a function once", () => {
    class Basket {}
    expect(service.wrap(Basket, "Basket")).toBe(Basket);
    expect(service.wrap(42, "answer")).toBe(42);
    const fn = () => 1;
    const wrapped = service.wrap(fn, "one");
    expect(service.wrap(fn, "one")).toBe(wrapped);
    expect(service.wrap(wrapped, "one")).toBe(wrapped);
  });

  it("wraps the functions on a CommonJS module's exports", () => {
    const module: { exports: unknown } = { exports: { double: (n: number) => n * 2, limit: 10 } };
    repository.wrapExports(module);
    expect((module.exports as { double: (n: number) => number }).double(2)).toBe(4);
    expect((module.exports as { limit: number }).limit).toBe(10);
    expect(named("double")).toHaveLength(1);
  });
});

describe("criterionPattern", () => {
  it.each([
    ["#<issue>/AC<n>", "#2 Add an item > #2/AC1 keeps an added item", "#2/AC1"],
    ["[REQ-<issue>.<n>]", "basket [REQ-12.3] restores", "[REQ-12.3]"],
    ["#<issue>/AC<n>", "#2 Add an item to the basket", undefined],
  ])("finds %s in %j", (tag, name, expected) => {
    expect(criterionPattern(tag).exec(name)?.[0]).toBe(expected);
  });
});
