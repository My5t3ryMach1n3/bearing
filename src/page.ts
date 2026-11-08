import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import { ClaimError } from "./claims.js";
import { runChecks, type CheckOptions, type CheckReport } from "./check.js";
import { codeChanges, sourceFiles } from "./code-changes.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { CoverageError } from "./coverage.js";
import { DeriveError } from "./derive.js";
import { IacError } from "./deployment.js";
import { buildPageData, elementStyles, type PageData } from "./page-data.js";
import { layOutLevels, type LevelLayout } from "./page-layout.js";
import type { PagePayload } from "./page-script.js";
import { gatherReport, pullRequestNumber, ReportError } from "./report.js";
import { RequirementsError } from "./requirements.js";
import { loadWorkspace, StructurizrError, type Workspace } from "./structurizr.js";

// `bearing page`: the architecture page for a PR, one HTML file with everything inlined: the page's data, each
// level's layout, the script that draws it (page-script.ts), its style and its fonts. The page follows the style guide
// from #117, spikes/architecture-page/style/README.md. See #116 and #120.
//
// The same inputs give the same file byte for byte: nothing in it depends on the time or the machine.

// The style guide's colour tokens. The page's CSS is written from these, and the tests check their contrast.
export const themes = {
  dark: {
    map: "#0e1822",
    grid: "#1d2d3b",
    chrome: "#080d12",
    "chrome-line": "#1a2530",
    "chrome-hover": "#0f1821",
    "chrome-text": "#c9d4dd",
    rail: "#12202c",
    line: "#26394a",
    node: "#13222f",
    "node-line": "#56718a",
    edge: "#6d8498",
    text: "#dce6ee",
    muted: "#8da1b3",
    faint: "#788ea1",
    added: "#5ed3c3",
    drift: "#ff6b81",
    untested: "#ffb25b",
    bar: "#ffb25b",
    "heat-1": "#3b3324",
    "heat-2": "#6e5026",
    "heat-3": "#b9802f",
    "heat-4": "#ffb25b",
    "heat-1-line": "#6e5026",
    "heat-2-line": "#b9802f",
    "heat-3-line": "#ffb25b",
    "heat-4-line": "#ffb25b",
    // The text on each heat step: the guide's `--text`, or `--on-heat` on the two brightest.
    "heat-1-text": "#dce6ee",
    "heat-2-text": "#dce6ee",
    "heat-3-text": "#1c1306",
    "heat-4-text": "#1c1306",
  },
  light: {
    map: "#f6f8fa",
    grid: "#dde3e9",
    chrome: "#ffffff",
    "chrome-line": "#d8dee4",
    "chrome-hover": "#eef2f5",
    "chrome-text": "#1f2933",
    rail: "#ffffff",
    line: "#c5ced6",
    node: "#ffffff",
    "node-line": "#7f8c99",
    edge: "#7b8794",
    text: "#1f2933",
    muted: "#52606d",
    faint: "#5f6b78",
    added: "#0f7b6c",
    drift: "#c4314b",
    untested: "#9a5b00",
    bar: "#a35c00",
    "heat-1": "#fde7c4",
    "heat-2": "#f7c27a",
    "heat-3": "#e0952e",
    "heat-4": "#a35c00",
    "heat-1-line": "#a35c00",
    "heat-2-line": "#a35c00",
    "heat-3-line": "#a35c00",
    "heat-4-line": "#7a4500",
    // `--text`, or `--on-heat` on the darkest.
    "heat-1-text": "#1f2933",
    "heat-2-text": "#1f2933",
    "heat-3-text": "#1f2933",
    "heat-4-text": "#ffffff",
  },
} as const;

export type Theme = Record<keyof (typeof themes)["dark"], string>;

const tokens = (theme: Theme) =>
  Object.entries(theme)
    .map(([name, value]) => `--${name}:${value};`)
    .join("");

// The fonts the guide sets, latin subset, from the @fontsource packages.
const fonts: Array<{ family: string; weight: number; file: string }> = [
  {
    family: "IBM Plex Mono",
    weight: 400,
    file: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
  },
  {
    family: "IBM Plex Mono",
    weight: 500,
    file: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
  },
  {
    family: "IBM Plex Sans",
    weight: 400,
    file: "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2",
  },
  {
    family: "IBM Plex Sans",
    weight: 600,
    file: "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2",
  },
];

async function fontFaces(): Promise<string> {
  const require = createRequire(import.meta.url);
  const faces: string[] = [];
  for (const font of fonts) {
    // The packages export only their CSS, so the font is found beside their licence.
    const [scope, name, ...rest] = font.file.split("/");
    const root = dirname(require.resolve(`${scope}/${name}/LICENSE`));
    const bytes = await readFile(join(root, ...rest));
    faces.push(
      `@font-face{font-family:"${font.family}";font-style:normal;font-weight:${font.weight};font-display:swap;` +
        `src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2")}`,
    );
  }
  return faces.join("\n");
}

// The page's script: page-script.js with page-modes.js inlined before it, as `tsc` compiled them, or compiled here
// from the TypeScript when running from the sources, as the tests do.
export async function pageScript(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = existsSync(join(here, "page-script.js"));
  const read = async (name: string): Promise<string> => {
    if (compiled) return readFile(join(here, `${name}.js`), "utf8");
    const { default: ts } = await import("typescript");
    const source = await readFile(join(here, `${name}.ts`), "utf8");
    return ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
  };
  const modes = (await read("page-modes")).replace(/^export /gm, "");
  const script = (await read("page-script")).replace(/^import\s*\{[^}]*\}\s*from\s*"\.\/page-modes\.js";\s*$/m, "");
  if (/^\s*(import|export)\b/m.test(modes + script)) {
    throw new Error("the page's script imports or exports something that can't be inlined");
  }
  return `(() => {\n"use strict";\n${modes.replace(/\/\/# sourceMappingURL=.*$/m, "")}\n${script.replace(/\/\/# sourceMappingURL=.*$/m, "")}\n})();`;
}

// JSON that's safe inside a script element: nothing in it can close the element or start a comment.
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface PageMeta {
  title: string;
  ref: string;
}

// The whole page, as one HTML file.
export async function renderPage(
  data: PageData,
  meta: PageMeta,
  layouts?: Record<string, LevelLayout>,
): Promise<string> {
  const payload: PagePayload = { data, layouts: layouts ?? (await layOutLevels(data)), ...meta };
  const script = await pageScript();
  // Nothing in the script may end its element early.
  if (/<\/script/i.test(script)) throw new Error("the page's script contains </script>");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<title>${escapeHtml(meta.title)}</title>
<style>
${await fontFaces()}
:root{${tokens(themes.dark)}color-scheme:dark}
@media (prefers-color-scheme: light){:root{${tokens(themes.light)}color-scheme:light}}
${style}
</style>
</head>
<body>
<header class="title">
<h1 id="title"></h1>
<span id="ref"></span>
<kbd>1–4 switch tabs</kbd>
</header>
<nav role="tablist" id="tabs" aria-label="Review"></nav>
<main class="work">
<div class="map">
<div class="bar">
<nav class="crumbs" id="crumbs" aria-label="Level"></nav>
<div class="controls" id="controls"></div>
</div>
<div class="canvas" id="canvas"></div>
</div>
<aside id="panel" role="tabpanel"></aside>
</main>
<script type="application/json" id="bearing-page">${scriptJson(payload)}</script>
<script>
${script}
</script>
</body>
</html>
`;
}

// The page's CSS, after the tokens. Sizes and roles follow the style guide.
const style = `
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--map);color:var(--text);font:14px/1.45 "IBM Plex Sans",system-ui,sans-serif;display:grid;grid-template-rows:auto auto minmax(0,1fr);grid-template-columns:minmax(0,1fr)}
button{font:inherit;color:inherit}
.mono,code{font-family:"IBM Plex Mono",ui-monospace,monospace}
.title{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;padding:10px 16px 6px;background:var(--chrome);font-family:"IBM Plex Mono",ui-monospace,monospace}
.title h1{font:500 14px "IBM Plex Mono",ui-monospace,monospace;margin:0;color:var(--chrome-text);overflow-wrap:anywhere}
.title h1::before{content:"$ ";color:var(--faint)}
.title span{color:var(--muted);font-size:12.5px}
.title kbd{margin-left:auto;color:var(--faint);font:12px "IBM Plex Mono",ui-monospace,monospace}
[role=tablist]{display:flex;background:var(--chrome);border-bottom:1px solid var(--chrome-line);padding:0 8px;overflow-x:auto}
[role=tab]{all:unset;cursor:pointer;display:flex;gap:8px;align-items:center;padding:9px 10px 10px;border-bottom:2px solid transparent;white-space:nowrap}
[role=tab]:hover{background:var(--chrome-hover)}
[role=tab]:focus-visible{outline:2px solid var(--added);outline-offset:-2px}
[role=tab][aria-selected=true]{border-bottom-color:var(--text)}
.tab-name{font:500 13px "IBM Plex Mono",ui-monospace,monospace;color:var(--muted)}
[role=tab][aria-selected=true] .tab-name{color:var(--text)}
.tab-result{font:12px/1 "IBM Plex Mono",ui-monospace,monospace;padding:3px 6px;border-radius:2px;border:1px solid var(--chrome-line);color:var(--chrome-text)}
[role=tab].attention .tab-result{border-color:var(--drift);color:var(--drift)}
[role=tab].quiet .tab-result{color:var(--faint)}
.work{display:grid;grid-template-columns:minmax(0,1fr) 340px;min-height:0;min-width:0}
.map{position:relative;overflow:auto;background-image:radial-gradient(var(--grid) 1px,transparent 1px);background-size:18px 18px;display:flex;flex-direction:column;min-width:0}
.bar{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;justify-content:space-between;padding:10px 20px 4px;font-size:13px;color:var(--muted)}
.crumbs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:12.5px}
.crumbs button{all:unset;cursor:pointer}
.crumbs button:hover{color:var(--text);text-decoration:underline}
.crumbs button:focus-visible{outline:2px solid var(--added)}
.crumbs .here{color:var(--text);font-weight:500}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--rail)}
.seg button{all:unset;cursor:pointer;padding:4px 12px;font:13px "IBM Plex Mono",ui-monospace,monospace;color:var(--muted)}
.seg.zoom button{padding:4px 9px}
.seg button[aria-pressed=true]{background:var(--line);color:var(--text)}
.seg button:hover{color:var(--text)}
.seg button:focus-visible{outline:2px solid var(--added);outline-offset:-2px}
select{background:var(--rail);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:13px "IBM Plex Mono",ui-monospace,monospace;max-width:100%}
.ramp{display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px;font:11.5px "IBM Plex Mono",ui-monospace,monospace}
.ramp span{padding:3px 7px;border-radius:3px}
.ramp .label{color:var(--muted);padding-right:8px}
.swatch.heat-1{background:var(--heat-1);color:var(--heat-1-text)}
.swatch.heat-2{background:var(--heat-2);color:var(--heat-2-text)}
.swatch.heat-3{background:var(--heat-3);color:var(--heat-3-text)}
.swatch.heat-4{background:var(--heat-4);color:var(--heat-4-text)}
.canvas{flex:1;padding:6px 16px 24px;overflow:auto}
.canvas svg{display:block;margin:0 auto}
aside{background:var(--chrome);border-left:1px solid var(--chrome-line);overflow:auto;padding:8px 0 40px;font:12.5px "IBM Plex Mono",ui-monospace,monospace;color:var(--chrome-text)}
.group{padding:0 16px 12px}
.group h2{font:500 12px "IBM Plex Mono",ui-monospace,monospace;color:var(--muted);margin:10px 0 4px;display:flex;gap:8px;align-items:baseline;padding-bottom:4px;border-bottom:1px solid var(--chrome-line);overflow-wrap:anywhere}
.group h2 small{font-size:12px;color:var(--faint);font-weight:400}
.sub{font-size:12px;color:var(--muted);margin:0 0 6px}
.sub.drift,.drift{color:var(--drift)}
.item{margin:0 -8px 1px}
.item-head{all:unset;box-sizing:border-box;display:block;width:100%;cursor:pointer;padding:5px 8px}
.item-head:hover{background:var(--chrome-hover)}
.item-head:focus-visible{outline:2px solid var(--added);outline-offset:-2px}
.item.on{background:var(--chrome-hover);box-shadow:inset 2px 0 0 var(--text)}
.item-row{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.item-name{font-weight:500;color:var(--chrome-text);overflow-wrap:anywhere}
.item-meta{font-size:12px;color:var(--muted);white-space:nowrap}
.item-meta.added{color:var(--added)}
.item-meta.drift{color:var(--drift)}
.item-meta.heat{color:var(--text)}
.item-sub{display:block;font-size:12px;color:var(--faint);overflow-wrap:anywhere}
.item-more{padding:0 8px 8px;font:12.5px/1.5 "IBM Plex Sans",system-ui,sans-serif;color:var(--muted)}
.item-more p{margin:4px 0;white-space:pre-line;overflow-wrap:anywhere}
.item-more .mono{font:12px "IBM Plex Mono",ui-monospace,monospace}
.item-more .prose{color:var(--chrome-text)}
.item-more ul{list-style:none;padding:0;margin:4px 0}
.item-more li{display:flex;flex-wrap:wrap;justify-content:space-between;column-gap:12px;margin:2px 0;font:12px "IBM Plex Mono",ui-monospace,monospace}
.item-more li span{overflow-wrap:anywhere}
.item-more li span+span{color:var(--faint)}
.elsewhere,.link{all:unset;cursor:pointer;display:block;padding:0 8px 5px;font-size:12px;color:var(--text);text-decoration:underline}
.link{display:inline;padding:0}
.elsewhere:focus-visible,.link:focus-visible{outline:2px solid var(--added)}
.bar-track{display:block;height:3px;background:var(--chrome-line);margin-top:5px}
.bar-fill{display:block;height:3px;background:var(--bar)}
.row{padding:4px 0}
ol.steps{list-style:none;padding:0;margin:0 -8px}
ol.steps .step{all:unset;box-sizing:border-box;display:grid;grid-template-columns:2.2em 1fr;width:100%;cursor:pointer;padding:3px 8px;font:12.5px "IBM Plex Mono",ui-monospace,monospace;color:var(--chrome-text)}
ol.steps.plain .step{cursor:default;color:var(--muted)}
ol.steps button.step:hover{background:var(--chrome-hover)}
ol.steps .step:focus-visible{outline:2px solid var(--added);outline-offset:-2px}
ol.steps .step.on{background:var(--chrome-hover);box-shadow:inset 2px 0 0 var(--text)}
ol.steps .order{color:var(--faint)}
ol.steps .untested{color:var(--untested)}
ol.steps .untested .order{color:var(--untested)}
.empty{padding:0 16px;margin:12px 0;color:var(--muted)}
.note{padding:0 16px;color:var(--faint);font-size:12px;overflow-wrap:anywhere}
.checks{padding:8px 16px 0;margin-top:8px;border-top:1px solid var(--chrome-line)}
.check{margin:4px 0;font-size:12px;color:var(--faint);overflow-wrap:anywhere}
.check .check-title{color:var(--muted)}
.check.failed,.check.failed .check-title{color:var(--drift)}
.check.flagged,.check.flagged .check-title{color:var(--untested)}
.diagram{font-family:"IBM Plex Sans",system-ui,sans-serif;overflow:visible}
.shape{fill:var(--node);stroke:var(--node-line);stroke-width:1.2}
.shape-line{fill:none;stroke:var(--node-line)}
.shape-dot{fill:var(--node-line)}
.node-kind{fill:var(--muted);font-size:11px}
.node-name{fill:var(--text);font-size:13.5px;font-weight:600}
.node-tech{fill:var(--muted);font:10.5px "IBM Plex Mono",ui-monospace,monospace}
.external .shape{stroke-dasharray:2 3;fill:var(--map)}
.boundary-box{fill:none;stroke:var(--node-line);stroke-dasharray:1 5;stroke-linecap:round;stroke-width:1.5}
.boundary-name{fill:var(--muted);font-size:12px;font-weight:600}
.edge-line{fill:none;stroke:var(--edge);stroke-width:1.2}
.edge-head{fill:var(--edge)}
.edge-label text{fill:var(--muted);font-size:11px}
.label-back{fill:var(--map);opacity:.85}
.node{cursor:pointer;outline:none}
.node:focus-visible .shape{stroke:var(--added);stroke-width:2.4}
.node,.edge,.edge-label{transition:opacity .2s}
.dim{opacity:.2}
.node.selected .shape{stroke:var(--text);stroke-width:2.4}
.node.added .shape,.node.changed .shape{stroke:var(--added);stroke-width:2}
.node.changed .shape{stroke-dasharray:5 3}
.node.added .node-kind,.node.changed .node-kind{fill:var(--added)}
.node.added.selected .shape,.node.changed.selected .shape{stroke-width:3.2}
.node.removed .shape{fill:none;stroke-dasharray:4 4}
.node.removed text{opacity:.6}
.edge.added .edge-line{stroke:var(--added);stroke-width:2}
.edge.added .edge-head,.edge.changed .edge-head{fill:var(--added)}
.edge-label.added text,.edge-label.changed text{fill:var(--added)}
.edge.changed .edge-line{stroke:var(--added);stroke-width:2;stroke-dasharray:2 3}
.edge.removed .edge-line{stroke:var(--faint);stroke-dasharray:4 4}
.edge.removed .edge-head{fill:var(--faint)}
.edge.drift .edge-line{stroke:var(--drift);stroke-width:2.4}
.edge.drift .edge-head{fill:var(--drift)}
.edge-label.drift text{fill:var(--drift);font-weight:600;font-size:12px}
.edge.selected .edge-line{stroke-width:3.6}
.edge-label.selected text{font-weight:600}
.node.unbuilt .shape{fill:none;stroke-dasharray:4 4}
.node.unbuilt text{opacity:.5}
.node.heat-1 .shape{fill:var(--heat-1);stroke:var(--heat-1-line)}
.node.heat-2 .shape{fill:var(--heat-2);stroke:var(--heat-2-line)}
.node.heat-3 .shape{fill:var(--heat-3);stroke:var(--heat-3-line)}
.node.heat-4 .shape{fill:var(--heat-4);stroke:var(--heat-4-line)}
.node.heat-1 text{fill:var(--heat-1-text)}
.node.heat-2 text{fill:var(--heat-2-text)}
.node.heat-3 text{fill:var(--heat-3-text)}
.node.heat-4 text{fill:var(--heat-4-text)}
.corner{fill:var(--muted);font:11px "IBM Plex Mono",ui-monospace,monospace}
.corner.faint{fill:var(--faint)}
.corner.added{fill:var(--added)}
.corner.drift{fill:var(--drift)}
.corner.heat{fill:var(--text);font-weight:500}
.edge.step .edge-line{stroke:var(--text);stroke-width:1.8}
.edge.step .edge-head{fill:var(--text)}
.edge.step.untested .edge-line{stroke:var(--untested);stroke-dasharray:4 4}
.edge.step.untested .edge-head{fill:var(--untested)}
.edge.step.current .edge-line{stroke-width:3.6}
.badge{cursor:pointer}
.badge circle{fill:var(--map);stroke:var(--text);stroke-width:1.3}
.badge text{fill:var(--text);font:600 10.5px "IBM Plex Mono",ui-monospace,monospace}
.badge.untested circle{stroke:var(--untested)}
.badge.untested text{fill:var(--untested)}
.badge.current circle{fill:var(--text)}
.badge.current text{fill:var(--map)}
.badge.current.untested circle{fill:var(--untested);stroke:var(--untested)}
@media (max-width:860px){
body{display:block;height:auto}
.work{display:block}
.map{overflow:visible}
aside{border-left:0;border-top:1px solid var(--chrome-line)}
.canvas{padding:4px 16px 16px}
.title kbd{display:none}
[role=tablist]{flex-wrap:wrap}
}
@media (prefers-reduced-motion:reduce){.node,.edge,.edge-label{transition:none}}
`;

// The PR's title and which PR and commit the page is for: from the pull request event in GitHub Actions, otherwise
// from git.
export async function pageMeta(root: string, env: NodeJS.ProcessEnv = process.env): Promise<PageMeta> {
  const git = async (...args: string[]) => {
    try {
      return (await promisify(execFile)("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
    } catch {
      return "";
    }
  };
  let event: { pull_request?: { title?: unknown; head?: { ref?: unknown; sha?: unknown } } } = {};
  if (env.GITHUB_EVENT_PATH) {
    try {
      event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as typeof event;
    } catch {
      // No readable event: fall back to git.
    }
  }
  const pr = event.pull_request;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const branch = text(pr?.head?.ref) ?? env.GITHUB_HEAD_REF ?? (await git("rev-parse", "--abbrev-ref", "HEAD"));
  const sha = (text(pr?.head?.sha) ?? (await git("rev-parse", "HEAD"))).slice(0, 7);
  const number = await pullRequestNumber(env);
  const title = text(pr?.title) ?? (await git("log", "-1", "--format=%s"));
  const ref = [number === undefined ? "" : `#${number}`, branch, sha === "" ? "" : `@ ${sha}`]
    .filter((part) => part !== "")
    .join(" ");
  return { title: title === "" ? branch || "Architecture" : title, ref };
}

// The PR's workspace, for its element styles: read when the model is workspace JSON, otherwise exported again, which
// Structurizr's cache makes cheap after the checks.
async function workspaceOf(config: Config): Promise<Workspace> {
  if (config.model.endsWith(".json")) {
    return JSON.parse(await readFile(join(config.root, config.model), "utf8")) as Workspace;
  }
  return loadWorkspace(config);
}

export interface PageOptions {
  check?: CheckReport;
  base?: string;
  checkOptions?: CheckOptions;
  env?: NodeJS.ProcessEnv;
}

// Everything the page shows, gathered from the repo, its history and the checks' results.
export async function gatherPage(
  config: Config,
  options: PageOptions = {},
): Promise<{ data: PageData; meta: PageMeta }> {
  const check = options.check ?? (await runChecks(config, options.checkOptions ?? {}));
  const { fork, target, forked, targetFiles, adrs } = await gatherReport(config, options.base);
  const data = buildPageData({
    check,
    target,
    forked,
    targetFiles,
    adrs,
    changes: await codeChanges(config, fork),
    sourceFiles: await sourceFiles(config),
    styles: elementStyles(await workspaceOf(config)),
  });
  return { data, meta: await pageMeta(config.root, options.env) };
}

export function pageCommand(): Command {
  return new Command("page")
    .description(
      "write the architecture page for the PR: one HTML file with everything inlined, with Target, Code, Build and Behaviour tabs over a map of the architecture",
    )
    .argument("[issues...]", "the issues to check coverage for, as for `bearing check`")
    .option("--branch <name>", "the branch whose claims file to check; defaults to the current one")
    .option("--base <ref>", "the branch this one forked from; defaults to the remote's default branch, then main")
    .option(
      "--check <file>",
      "read the results `bearing check --json` wrote to this file instead of running the checks",
    )
    .option("--out <file>", "write the page to this file rather than printing it")
    .action(async function (
      this: Command,
      issues: string[],
      options: { branch?: string; base?: string; check?: string; out?: string },
    ) {
      const numbers = issues.map((issue) => /^#?(\d+)$/.exec(issue.trim())?.[1]);
      const bad = issues.find((_, index) => numbers[index] === undefined);
      if (bad !== undefined) this.error(`error: "${bad}" is not an issue number, e.g. 2 or '#2'`);
      try {
        const config = loadConfig();
        const check =
          options.check === undefined ? undefined : (JSON.parse(await readFile(options.check, "utf8")) as CheckReport);
        const { data, meta } = await gatherPage(config, {
          ...(check === undefined ? {} : { check }),
          ...(options.base === undefined ? {} : { base: options.base }),
          checkOptions: {
            ...(issues.length > 0 ? { issues: numbers.map(Number) } : {}),
            ...(options.branch === undefined ? {} : { branch: options.branch }),
            ...(options.base === undefined ? {} : { base: options.base }),
          },
        });
        const html = await renderPage(data, meta);
        if (options.out === undefined) process.stdout.write(html);
        else {
          await writeFile(options.out, html);
          process.stderr.write(`Wrote the architecture page to ${options.out}\n`);
        }
      } catch (error) {
        if (
          error instanceof ConfigError ||
          error instanceof StructurizrError ||
          error instanceof DeriveError ||
          error instanceof IacError ||
          error instanceof ClaimError ||
          error instanceof RequirementsError ||
          error instanceof CoverageError ||
          error instanceof ReportError
        ) {
          this.error(`error: ${error.message}`);
        }
        if (error instanceof SyntaxError && options.check !== undefined) {
          this.error(`error: ${options.check} is not \`bearing check --json\` output: ${error.message}`);
        }
        throw error;
      }
    });
}
