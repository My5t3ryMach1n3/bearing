import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChecks } from "../src/check.js";
import { loadConfig } from "../src/config.js";
import { modelFromWorkspace, type Model } from "../src/model.js";
import { buildPageData, elementStyles, type PageInputs } from "../src/page-data.js";
import { gatherPage, pageMeta, renderPage, scriptJson, themes, type Theme } from "../src/page.js";
import { skipped } from "./checks.js";
import { basketDir, basketRepo, git, variantRepo } from "./basket.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "target-changes", `${name}.json`), "utf8"));
const load = (name: string) => modelFromWorkspace(fixture(name));
const meta = { title: "Share a basket by email", ref: "#42 share-a-basket @ 3f9c2e1" };

// Set BEARING_PAGE_OUT to a directory to keep the pages the tests write, to look at in a browser.
function keep(name: string, html: string): void {
  const out = process.env.BEARING_PAGE_OUT;
  if (out === undefined || out === "") return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.html`), html);
}

// The sharing design (basket#16) on top of the initial target, with code changes and the controller importing the
// repository.
function sharingInputs(overrides: Partial<PageInputs> = {}): PageInputs {
  const check = skipped();
  check.checks[3] = {
    check: "boundaries",
    status: "failed",
    blocking: true,
    undeclared: [
      {
        id: "basketController->basketRepository",
        source: "basketController",
        destination: "basketRepository",
        imports: [
          { file: "src/basket-api/basket-controller/index.ts", line: 3, module: "../basket-repository/index.js" },
        ],
      },
    ],
    queues: [],
  };
  return {
    check,
    target: load("sharing"),
    forked: load("initial"),
    targetFiles: ["architecture/workspace.dsl"],
    adrs: [
      {
        path: "architecture/adrs/0004-share-emails-through-an-outbox.md",
        text: "# 0004. Send share emails through an outbox\n\n## Context\n\nA slow email provider mustn't hold up the basket API.\n\n## Decision\n\nAn outbox.\n\n## Alternatives considered\n\n- Calling the provider inline: too slow.\n",
      },
    ],
    changes: [
      { path: "src/basket-api/basket-sharing/index.ts", added: 120, removed: 0 },
      { path: "src/basket-api/basket-controller/index.ts", added: 10, removed: 4 },
      { path: "src/basket-api/utils/email-template.ts", added: 46, removed: 0 },
    ],
    sourceFiles: [
      "src/basket-api/basket-controller/index.ts",
      "src/basket-api/basket-repository/index.ts",
      "src/basket-api/basket-service/index.ts",
      "src/basket-api/basket-sharing/index.ts",
      "src/basket-api/session-restore/index.ts",
    ],
    styles: elementStyles(fixture("sharing")),
    ...overrides,
  };
}

// Opens a page in jsdom with its script running, at a hash.
function open(html: string, hash = ""): Document {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: `https://example.com/page.html${hash}` });
  return dom.window.document;
}

const text = (document: Document, selector: string) =>
  [...document.querySelectorAll(selector)].map((each) => each.textContent ?? "");

const click = (node: Element | null | undefined) =>
  node?.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent("click", { bubbles: true }));

describe("the page for the sharing change", async () => {
  const data = buildPageData(sharingInputs());
  const html = await renderPage(data, meta);
  keep("sharing", html);

  it("loads nothing from outside the file", () => {
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]*\s(src|href)=/i);
    expect(html).not.toMatch(/url\((?!data:)/);
    expect(html).not.toMatch(/@import/);
    // Its script is inlined, with page-modes.js before it, and imports nothing.
    expect(html).not.toMatch(/^\s*import\b/m);
    expect(html).toContain("function shown(");
  });

  it("has the four tabs in order, each with its counter, red when it needs the reviewer", () => {
    const document = open(html);
    expect(text(document, "[role=tab] .tab-name")).toEqual(["Target", "Code", "Build", "Behaviour"]);
    expect(text(document, "[role=tab] .tab-result")).toEqual([
      data.tabs.target.counter,
      "+176 −4",
      "1 undeclared",
      "not checked",
    ]);
    const build = document.querySelector("#tab-build")!;
    expect(build.classList.contains("attention")).toBe(true);
    expect(document.querySelector("#tab-code")!.classList.contains("attention")).toBe(false);
    expect(document.getElementById("title")!.textContent).toBe(meta.title);
  });

  it("opens on the level the PR changes most, with Before, Change and After on the Target tab", () => {
    const document = open(html);
    expect(document.location.hash).toContain("level=basketApi");
    expect(text(document, "#controls .seg:not(.zoom) button")).toEqual(["Before", "Change", "After"]);
    expect(text(document, "#panel h2")).toEqual(expect.arrayContaining([expect.stringMatching(/^Added\d+$/), "ADR1"]));
    expect(document.querySelector(".node.added[data-id=basketSharing]")).not.toBeNull();
  });

  it("lists findings on another level with a link there, and keeps the level when the tab changes", () => {
    const document = open(html, "#level=context");
    const sharing = document.querySelector('.item[data-key="el:basketSharing"]');
    expect(sharing?.querySelector(".elsewhere")?.textContent).toBe("Basket API ›");
    // The provider is drawn here, so it needs no link.
    expect(document.querySelector('.item[data-key="el:emailProvider"] .elsewhere')).toBeNull();
    click(sharing?.querySelector(".elsewhere"));
    expect(document.location.hash).toContain("level=basketApi");
    expect(document.querySelector(".node.selected[data-id=basketSharing]")).not.toBeNull();
    click(document.getElementById("tab-build"));
    expect(document.location.hash).toContain("tab=build");
    expect(document.location.hash).toContain("level=basketApi");
  });

  it("shows a box with a level of its own as what's inside it for the tab", () => {
    const document = open(html, "#tab=code&level=basket");
    const api = document.querySelector(".node[data-id=basketApi]")!;
    expect(api.querySelector(".corner")?.textContent).toBe("+130 −4 inside ›");
    expect(api.getAttribute("class")).toContain("heat-3");
    click(api);
    expect(document.location.hash).toContain("level=basketApi");
  });

  it("selects a finding: opens its detail and marks it on the map", () => {
    const document = open(html, "#tab=build&level=basketApi");
    const drift = document.querySelector('.item[data-key="drift:basketController->basketRepository"] .item-head');
    click(drift);
    expect(document.querySelector(".item.on .item-more")?.textContent).toContain(
      "The target routes this through Basket service or Session restore",
    );
    expect(document.querySelector(".edge.drift.selected")).not.toBeNull();
    expect(document.location.hash).toContain("sel=drift%3AbasketController-%3EbasketRepository");
  });

  it("counts code by component, with code outside the model in red and a key above the map", () => {
    const document = open(html, "#tab=code&level=basketApi");
    expect(text(document, "#panel h2")).toEqual(["Components2", "Outside the model1"]);
    expect(text(document, ".ramp span")).toEqual(["Lines changed", "1–9", "10–49", "50–149", "150+"]);
    expect(document.querySelector(".node[data-id=basketSharing] .corner")?.textContent).toBe("+120 −0 · 1 file");
  });

  it("switches tabs with the number keys and keeps the state in the hash", () => {
    const document = open(html);
    const window = document.defaultView!;
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "3", bubbles: true }));
    expect(document.querySelector("[aria-selected=true] .tab-name")?.textContent).toBe("Build");
    expect(open(html, "#tab=behaviour&level=basket").querySelector("[aria-selected=true]")?.id).toBe("tab-behaviour");
  });

  it("is the same byte for byte from the same inputs", async () => {
    expect(await renderPage(buildPageData(sharingInputs()), meta)).toBe(html);
  });
});

describe("a dynamic view on the Behaviour tab", async () => {
  // #5's steps between components, of which the one test takes all but the last.
  const target = load("sharing");
  const components = new Set(
    [...target.elements.values()].filter((each) => each.type === "component").map((each) => each.id),
  );
  const expected = target.dynamicViews
    .get("req-5")!
    .steps.filter((step) => components.has(step.source) && components.has(step.destination))
    .map(({ source, destination, description }) => ({ source, destination, description }));
  const check = skipped();
  check.checks[6] = {
    check: "paths",
    status: "failed",
    blocking: true,
    issues: ["#5"],
    views: [
      {
        issue: "#5",
        view: "req-5",
        description: "#5 Share the basket by email",
        status: "failed",
        components: [],
        expected,
        tests: [
          {
            name: "#5/AC1 emails a link",
            criterion: "#5/AC1",
            status: "matched",
            observed: expected
              .slice(0, -1)
              .map(({ source, destination }) => ({ source, destination, functions: ["f"] })),
            steps: expected.map((_, index) => (index < expected.length - 1 ? index : null)),
            undeclared: [],
            offTarget: [],
          },
        ],
        uncovered: [expected.length - 1],
      },
    ],
  };
  const data = buildPageData(sharingInputs({ check }));
  const html = await renderPage(data, meta);
  keep("behaviour", html);

  it("picks the view, numbers its steps on their edges and marks the steps no test takes", () => {
    const document = open(html, "#tab=behaviour&level=basketApi&view=req-5");
    expect(document.querySelector("select")?.value).toBe("req-5");
    expect(document.querySelector("#tab-behaviour .tab-result")?.textContent).toBe("1 untested");
    expect(text(document, "ol.steps .step.untested")).toEqual([expect.stringContaining("no test takes it")]);
    expect(text(document, "#panel .sub")).toContain(
      `#5/AC1 stops after step ${data.views[0]!.steps[data.views[0]!.trace!.tests[0]!.reached - 1]!.order}`,
    );
    expect(document.querySelectorAll(".badge").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".badge.untested").length).toBe(1);
    click(document.querySelector(".steps .step"));
    expect(document.location.hash).toContain("step=1");
  });
});

describe("the model's text", async () => {
  const hostile = '<img src=x onerror="window.pwned=1"></script><script>window.pwned=1</script><!--';
  const target = load("sharing");
  const forked = load("initial");
  const taint = (model: Model) => {
    for (const element of model.elements.values()) {
      if (element.id === "basketSharing" || element.id === "basketApi" || element.id === "basket") {
        element.name = `${element.name} ${hostile}`;
        element.description = hostile;
        element.technology = hostile;
      }
    }
    for (const relationship of model.relationships.values()) relationship.description = hostile;
  };
  taint(target);
  taint(forked);
  const data = buildPageData(sharingInputs({ target, forked }));
  const html = await renderPage(data, { title: hostile, ref: hostile });
  keep("hostile", html);

  it("reaches the page only as text", () => {
    // Two script elements, the data and the script, and nothing else that could run.
    expect(html.match(/<script/gi)).toHaveLength(2);
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    expect(html).not.toContain("<img");
    const document = open(html, "#tab=target&level=basketApi&sel=el%3AbasketSharing");
    expect((document.defaultView as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(document.querySelectorAll("img, iframe").length).toBe(0);
    expect(document.querySelectorAll("script").length).toBe(2);
    expect(document.title).toBe(hostile);
    expect(document.getElementById("title")?.textContent).toBe(hostile);
    expect(text(document, ".node[data-id=basketSharing] title")[0]).toContain(hostile);
    expect(text(document, ".item.on .item-more p")).toContain(hostile);
    // Relationship labels, as written (cut to fit the label's room on the map).
    expect(document.querySelector(".edge-label text")?.textContent).toMatch(/^<img src=x/);
  });

  it("is escaped inside the data's script element", () => {
    expect(scriptJson({ a: "</script><!--" })).toBe('{"a":"\\u003c/script\\u003e\\u003c!--"}');
  });
});

describe("a PR that changes nothing", async () => {
  const model = load("sharing");
  const html = await renderPage(
    buildPageData({ ...sharingInputs(), target: model, forked: model, changes: [], targetFiles: [], adrs: [] }),
    meta,
  );
  keep("quiet", html);

  it("keeps every tab in its place with a quiet counter", () => {
    const document = open(html);
    expect(text(document, "[role=tab] .tab-result")).toEqual(["no change", "no change", "1 undeclared", "not checked"]);
    expect(document.querySelector("#tab-target")!.classList.contains("quiet")).toBe(true);
    expect(document.querySelector("#tab-code")!.classList.contains("quiet")).toBe(true);
    expect(text(document, "#panel .empty")).toEqual(["No change to the target."]);
    // No Before / Change / After when there's nothing before.
    expect(document.querySelectorAll("#controls .seg:not(.zoom)").length).toBe(0);
  });
});

// WCAG's relative luminance and contrast ratio.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe("the guide's contrast", () => {
  for (const [name, theme] of Object.entries(themes) as Array<[string, Theme]>) {
    it(`holds for text and marks in the ${name} theme`, () => {
      const failures: string[] = [];
      const need = (fg: keyof Theme, bg: keyof Theme, ratio: number) => {
        const actual = contrast(theme[fg], theme[bg]);
        if (actual < ratio) failures.push(`${fg} on ${bg}: ${actual.toFixed(2)} < ${ratio}`);
      };
      // Text: 4.5:1 on what it sits on.
      for (const fg of ["text", "muted", "faint", "added", "drift", "untested"] as const) {
        for (const bg of ["map", "node", "chrome", "chrome-hover"] as const) need(fg, bg, 4.5);
      }
      need("chrome-text", "chrome", 4.5);
      need("chrome-text", "chrome-hover", 4.5);
      need("text", "line", 4.5);
      need("muted", "rail", 4.5);
      // Lines and marks: 3:1 against the map.
      for (const fg of ["node-line", "edge", "added", "drift", "untested", "text"] as const) need(fg, "map", 3);
      need("bar", "chrome", 3);
      // Every label on a heat box.
      for (const step of [1, 2, 3, 4] as const) {
        need(`heat-${step}-text`, `heat-${step}`, 4.5);
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("the page for a basket branch, from the real checks", () => {
  beforeEach(() => vi.stubEnv("BEARING_ISSUES_FILE", join(basketDir, "issues.json")));
  afterEach(() => vi.unstubAllEnvs());

  it("is the same byte for byte across runs", async () => {
    const root = variantRepo("controller-imports-repository");
    const config = loadConfig(root);
    const check = await runChecks(config, { base: "main" });
    const env = {};
    const first = await gatherPage(config, { check, base: "main", env });
    const html = await renderPage(first.data, first.meta);
    keep("basket-controller-imports-repository", html);
    const second = await gatherPage(config, { check, base: "main", env });
    expect(await renderPage(second.data, second.meta)).toBe(html);
    const document = open(html);
    expect(text(document, "[role=tab] .tab-result")).toEqual(["no change", "+11 −2", "1 undeclared", "covered"]);
  });

  it("names the branch and commit from git outside GitHub Actions", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "share-a-basket");
    git(root, "commit", "-q", "--allow-empty", "-m", "Share a basket by email");
    const sha = git(root, "rev-parse", "--short=7", "HEAD").trim();
    expect(await pageMeta(root, {})).toEqual({
      title: "Share a basket by email",
      ref: `share-a-basket @ ${sha}`,
    });
  });
});
