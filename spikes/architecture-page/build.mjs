#!/usr/bin/env node
// Writes the architecture page for a PR: one self-contained HTML file, from the inputs `bearing report` reads.
//
//   node build.mjs [--repo <dir>] [--base <ref>] [--check <check.json>] [--out <page.html>]
//   node build.mjs --workspace <workspace.json> [--out <page.html>]    a model on its own: no PR, no checks
//
// `--routing orthogonal|polyline|splines` picks how ELK routes edges, to compare them.
//
// Imports Bearing from ../../dist, so run `npm run build` at the repo root first.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runChecks } from "../../dist/check.js";
import { loadConfig } from "../../dist/config.js";
import { gatherReport } from "../../dist/report.js";
import { modelFromWorkspace } from "../../dist/model.js";
import { loadWorkspace } from "../../dist/structurizr.js";
import { defaultLayout, pageData } from "./page.mjs";

const here = import.meta.dirname;

const { values: args } = parseArgs({
  options: {
    repo: { type: "string", default: "." },
    base: { type: "string" },
    check: { type: "string" },
    out: { type: "string", default: "architecture.html" },
    workspace: { type: "string" },
    routing: { type: "string" },
  },
});

let before, after, check, workspace;
if (args.workspace !== undefined) {
  workspace = JSON.parse(await readFile(args.workspace, "utf8"));
  before = after = modelFromWorkspace(workspace);
  check = { checks: [] };
} else {
  const config = loadConfig(resolve(args.repo));
  check =
    args.check === undefined
      ? await runChecks(config, args.base === undefined ? {} : { base: args.base })
      : JSON.parse(await readFile(args.check, "utf8"));
  ({ target: after, forked: before } = await gatherReport(config, args.base));
  // The PR's own workspace, for the element styles its views set, such as a cylinder for a database.
  workspace = await loadWorkspace(config);
}
const layout =
  args.routing === undefined
    ? defaultLayout
    : { ...defaultLayout, elk: { ...defaultLayout.elk, "elk.edgeRouting": args.routing.toUpperCase() } };
const styles = workspace.views?.configuration?.styles?.elements ?? [];
const data = await pageData(before, after, check, { styles, layout });
const template = await readFile(join(here, "template.html"), "utf8");
// JSON in a script element ends at the first "</script", so every "<" goes in escaped.
const json = JSON.stringify(data).replaceAll("<", "\\u003c");
// Prettier may space the placeholder out, so any whitespace between its parts matches.
const placeholder = /\/\*DATA\*\/\s*null/;
if (!placeholder.test(template)) throw new Error("template.html has no /*DATA*/ null placeholder");
const page = template.replace(placeholder, () => json);
await mkdir(dirname(resolve(args.out)), { recursive: true });
await writeFile(args.out, page);
process.stderr.write(`Wrote ${args.out} (${(page.length / 1024).toFixed(0)} KB)\n`);
