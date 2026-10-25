import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { Command } from "commander";
import { changedPaths, changedSourceFiles, ClaimError, claimsDir, forkPoint, targetAtFork } from "./claims.js";
import { checkTitles, formatCheck, runChecks, type CheckOptions, type CheckReport } from "./check.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { CoverageError } from "./coverage.js";
import { DeriveError } from "./derive.js";
import { diffModels, loadModel, type Changes, type Drift, type ModelDiff } from "./diff.js";
import { githubRepository, githubToken } from "./github.js";
import type { Model } from "./model.js";
import { componentOf, componentPaths } from "./paths.js";
import { RequirementsError } from "./requirements.js";
import { exportStaticSite, StructurizrError } from "./structurizr.js";
import { TerraformError } from "./terraform.js";

// `bearing report`: the PR comment. A summary of every check comes first, then one Mermaid overlay of the elements
// the PR affects, with what it adds, removes and drifts in colour, then each failing or flagged check's details. In
// target-change mode the target's own diff comes before all of it, so whoever merges sees it first. See the How
// `bearing report` works section of docs/product-spec.md.

// Marks Bearing's comment, so each run updates it in place rather than adding another.
export const reportMarker = "<!-- bearing:report -->";

export interface ReportInputs {
  check: CheckReport;
  // The PR's target.
  target: Model;
  // The target at the fork point, before the PR: `target` itself, the same object, when the PR doesn't change it.
  forked: Model;
  // The files the PR changes that put it in target-change mode. Empty when it isn't in that mode.
  targetFiles: string[];
  // The source files the PR changes, with the component whose path holds each.
  files: Array<{ path: string; component?: string }>;
  // Where the Structurizr static site of the PR's target can be found.
  siteUrl?: string;
}

// The overlay stops adding context, the elements around the affected ones, once it has this many. The affected
// elements themselves are always drawn.
export const overlayLimit = 15;

// Added and removed are the PR's changes to the target; drifted is a change to the target's fields, or code that
// doesn't do what the target says.
export type Mark = "added" | "removed" | "drifted";

export interface Overlay {
  nodes: OverlayNode[];
  edges: OverlayEdge[];
}

export interface OverlayNode {
  // Stable ID of the element or deployment element; a Terraform resource's address for a node only it has.
  id: string;
  name: string;
  // What it is, e.g. "Component" or "Deployment node", and its technology.
  kind: string;
  // The name of the box it's drawn in: its container or software system, or its deployment environment.
  group?: string;
  mark?: Mark;
}

export interface OverlayEdge {
  source: string;
  destination: string;
  label: string;
  mark?: Mark;
}

const kinds = {
  person: "Person",
  softwareSystem: "Software system",
  container: "Container",
  component: "Component",
  deploymentNode: "Deployment node",
  infrastructureNode: "Infrastructure node",
  containerInstance: "Container instance",
  softwareSystemInstance: "Software system instance",
};

// The elements the PR affects, and the relationships between them:
// - in target-change mode, what the PR's target adds, removes or changes in the fork point's;
// - relationships the code makes that the target doesn't declare (Boundaries);
// - deployment nodes the Terraform adds, lacks or counts differently from the target (Deployment);
// - calls a tagged test made that its issue's dynamic view doesn't have, and the view's steps it missed (Trace paths).
//
// Around them it draws, as context, the target's relationships between the elements it shows, and the component an
// undeclared relationship skips, as long as that keeps it within `overlayLimit` elements.
export function buildOverlay(inputs: Pick<ReportInputs, "check" | "target" | "forked">): Overlay {
  const { check, target, forked } = inputs;
  const nodes = new Map<string, OverlayNode>();
  const edges = new Map<string, OverlayEdge>();
  const pairOf = (edge: { source: string; destination: string }) => `${edge.source}->${edge.destination}`;

  const node = (id: string, mark?: Mark): void => {
    const existing = nodes.get(id);
    if (existing !== undefined) {
      if (mark !== undefined) existing.mark = mark;
      return;
    }
    const element = target.elements.get(id) ?? forked.elements.get(id);
    const deployment = target.deployment.get(id) ?? forked.deployment.get(id);
    let added: OverlayNode;
    if (element !== undefined) {
      const parent =
        element.parent === undefined
          ? undefined
          : (target.elements.get(element.parent) ?? forked.elements.get(element.parent));
      added = { id, name: element.name, kind: describe(kinds[element.type], element.technology) };
      if (parent !== undefined) added.group = parent.name;
    } else if (deployment !== undefined) {
      added = { id, name: deployment.name, kind: describe(kinds[deployment.type], deployment.technology) };
      added.group = deployment.environment;
    } else {
      added = { id, name: id, kind: "" };
    }
    if (mark !== undefined) added.mark = mark;
    nodes.set(id, added);
  };
  const edge = (added: OverlayEdge): void => {
    const key = pairOf(added);
    const existing = edges.get(key);
    // A marked edge replaces context; two marked ones between the same pair keep the first's mark.
    if (existing !== undefined && (existing.mark !== undefined || added.mark === undefined)) return;
    node(added.source);
    node(added.destination);
    edges.set(key, added);
  };

  if (forked !== target) {
    const diff = diffModels(forked, target);
    for (const mark of ["added", "removed", "drifted"] as const) {
      for (const item of diff.elements[mark]) node(item.id, mark);
      for (const item of diff.deployment[mark]) node(item.id, mark);
    }
    for (const mark of ["added", "removed"] as const) {
      for (const relationship of diff.relationships[mark]) {
        edge({ ...endpoints(relationship), label: relationship.description, mark });
      }
    }
    for (const { id } of diff.relationships.drifted) {
      const relationship = target.relationships.get(id)!;
      edge({ ...endpoints(relationship), label: relationship.description, mark: "drifted" });
    }
  }

  // The undeclared relationships the code makes, which context may route around.
  const skipped: OverlayEdge[] = [];
  for (const each of check.checks) {
    if (each.check === "boundaries") {
      for (const relationship of each.undeclared) {
        const drifted: OverlayEdge = { ...endpoints(relationship), label: "imports, undeclared", mark: "drifted" };
        edge(drifted);
        skipped.push(drifted);
      }
    } else if (each.check === "deployment") {
      for (const added of each.added) {
        nodes.set(added.id, {
          id: added.id,
          name: added.resource.address,
          kind: describe("Not in the target", added.technology),
          ...(each.environment === undefined ? {} : { group: each.environment }),
          mark: "drifted",
        });
      }
      for (const removed of each.removed) node(removed.id, "drifted");
      for (const drift of each.drifted) node(drift.id, "drifted");
    } else if (each.check === "paths") {
      for (const view of each.views) {
        const expected = new Set(view.expected.map(pairOf));
        const calls = new Map<
          string,
          { source: string; destination: string; criteria: Set<string>; functions: Set<string> }
        >();
        for (const test of view.tests.filter((path) => path.status === "unmatched")) {
          for (const call of test.observed) {
            const key = `${call.source}->${call.destination}`;
            if (call.source === undefined || expected.has(key)) continue;
            const found = calls.get(key) ?? {
              source: call.source,
              destination: call.destination,
              criteria: new Set(),
              functions: new Set(),
            };
            calls.set(key, found);
            found.criteria.add(test.criterion);
            for (const name of call.functions) found.functions.add(`${name}()`);
          }
          test.steps.forEach((call, step) => {
            const missed = view.expected[step]!;
            if (call === null) edge({ ...endpoints(missed), label: `${view.view}: ${missed.description}` });
          });
        }
        for (const call of calls.values()) {
          edge({
            source: call.source,
            destination: call.destination,
            label: `${[...call.criteria].sort().join(", ")} trace: ${[...call.functions].join(", ")}`,
            mark: "drifted",
          });
        }
      }
    }
  }

  // Context: the component each undeclared relationship skips, then the target's relationships between what's shown.
  const relationships = [...target.relationships.values()];
  for (const drifted of skipped) {
    for (const first of relationships.filter((relationship) => relationship.source === drifted.source)) {
      const second = relationships.find(
        (relationship) => relationship.source === first.destination && relationship.destination === drifted.destination,
      );
      if (second === undefined) continue;
      if (!nodes.has(first.destination) && nodes.size >= overlayLimit) continue;
      edge({ ...endpoints(first), label: first.description });
      edge({ ...endpoints(second), label: second.description });
    }
  }
  for (const relationship of relationships) {
    if (nodes.has(relationship.source) && nodes.has(relationship.destination)) {
      edge({ ...endpoints(relationship), label: relationship.description });
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function endpoints(relationship: { source: string; destination: string }) {
  return { source: relationship.source, destination: relationship.destination };
}

function describe(kind: string, technology: string): string {
  return technology === "" ? kind : `${kind}: ${technology}`;
}

const colours: Record<Mark, { node: string; link: string }> = {
  added: { node: "fill:#dafbe1,stroke:#1a7f37,color:#1f2328", link: "stroke:#1a7f37,stroke-width:2px" },
  removed: {
    node: "fill:#f6f8fa,stroke:#8c959f,stroke-dasharray:4 3,color:#59636e",
    link: "stroke:#8c959f,stroke-width:2px",
  },
  drifted: { node: "fill:#ffebe9,stroke:#cf222e,color:#1f2328", link: "stroke:#cf222e,stroke-width:2px" },
};

// The overlay as a Mermaid flowchart, each element in a box for its container or environment.
export function formatMermaid(overlay: Overlay): string {
  const ids = new Map(overlay.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ["flowchart LR"];
  const groups = new Map<string | undefined, OverlayNode[]>();
  for (const node of overlay.nodes) groups.set(node.group, [...(groups.get(node.group) ?? []), node]);
  const label = (node: OverlayNode) =>
    `${ids.get(node.id)}["${escape(node.name)}${node.kind === "" ? "" : `<br/>[${escape(node.kind)}]`}"]`;
  let group = 0;
  for (const [name, members] of groups) {
    if (name === undefined) {
      for (const node of members) lines.push(`  ${label(node)}`);
      continue;
    }
    lines.push(`  subgraph g${group++}["${escape(name)}"]`);
    for (const node of members) lines.push(`    ${label(node)}`);
    lines.push("  end");
  }
  overlay.edges.forEach((edge) => {
    const arrow = edge.mark === "removed" ? "-.->" : "-->";
    const text = edge.label === "" ? "" : `|"${escape(edge.label)}"|`;
    lines.push(`  ${ids.get(edge.source)} ${arrow}${text} ${ids.get(edge.destination)}`);
  });
  for (const mark of ["added", "removed", "drifted"] as const) {
    const marked = overlay.nodes.filter((node) => node.mark === mark).map((node) => ids.get(node.id));
    const links = overlay.edges.flatMap((edge, index) => (edge.mark === mark ? [index] : []));
    if (marked.length > 0)
      lines.push(`  classDef ${mark} ${colours[mark].node}`, `  class ${marked.join(",")} ${mark}`);
    if (links.length > 0) lines.push(`  linkStyle ${links.join(",")} ${colours[mark].link}`);
  }
  return lines.join("\n");
}

// Mermaid reads quotes, angle brackets and the like in a label as syntax, so they go in as its entity codes.
function escape(text: string): string {
  return text.replace(/["<>#|]/g, (char) => `#${char.charCodeAt(0)};`);
}

// GitHub rejects a comment longer than this.
const commentLimit = 65_536;

// The PR comment, in GitHub-flavoured Markdown.
export function formatComment(inputs: ReportInputs): string {
  const { check, target, forked, targetFiles, files, siteUrl } = inputs;
  const failed = check.checks.filter((each) => each.status === "failed").map((each) => checkTitles[each.check]);
  const flagged = check.checks.filter((each) => each.status === "flagged").map((each) => checkTitles[each.check]);
  let verdict =
    failed.length === 0
      ? "✅ All blocking checks passed"
      : `❌ ${failed.length} blocking ${failed.length === 1 ? "check" : "checks"} failed: ${failed.join(", ")}`;
  if (flagged.length > 0) verdict += ` · ⚠️ advisory: ${flagged.join(", ")} flagged`;
  const sections = [reportMarker, `## Bearing: ${verdict}`];

  if (targetFiles.length > 0)
    sections.push(formatTargetChange(forked === target ? undefined : diffModels(forked, target), targetFiles));

  const rows = check.checks.map((each) => {
    const title = each.blocking ? checkTitles[each.check] : `${checkTitles[each.check]} (advisory)`;
    return `| ${title} | ${statusIcons[each.status]} ${each.status} | ${cell(summarise(each))} |`;
  });
  sections.push(["### Checks", "", "| Check | Result | |", "| --- | --- | --- |", ...rows].join("\n"));

  const overlay = buildOverlay(inputs);
  sections.push(
    overlay.nodes.length === 0
      ? "### Overlay\n\nNothing is added to, removed from or drifted from the target."
      : [
          "### Overlay",
          "",
          "```mermaid",
          formatMermaid(overlay),
          "```",
          "",
          "Only the affected elements and their neighbours. 🟩 added to the target · ⬜ removed from it, dashed · 🟥 drifted: changed in the target, or code that doesn't do what it says",
        ].join("\n"),
  );

  const details = check.checks
    .filter((each) => each.status === "failed" || each.status === "flagged")
    .map(
      (each) =>
        `<details><summary>${checkTitles[each.check]}: ${each.status}</summary>\n\n\`\`\`text\n${formatCheck(each).trimEnd()}\n\`\`\`\n\n</details>`,
    );
  if (files.length > 0) {
    const table = files.map(
      (file) => `| \`${cell(file.path)}\` | ${file.component === undefined ? "none" : `\`${file.component}\``} |`,
    );
    details.push(
      `<details><summary>Changed source files by component</summary>\n\n| File | Component |\n| --- | --- |\n${table.join("\n")}\n\n</details>`,
    );
  }
  const footer =
    siteUrl === undefined ? [] : [`[Every view of this PR's target in Structurizr](${siteUrl}), as a static site.`];

  const comment = (parts: string[]) => `${[...sections, ...parts, ...footer].join("\n\n")}\n`;
  const full = comment(details);
  return full.length <= commentLimit
    ? full
    : comment(["The details are too long for a comment; run `bearing check` to see them."]);
}

const statusIcons = { passed: "✅", failed: "❌", skipped: "⏭️", flagged: "⚠️" };

// One line on what a check found, for the summary table.
function summarise(check: CheckReport["checks"][number]): string {
  if (check.status === "skipped") return check.reason ?? "";
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  switch (check.check) {
    case "claim":
      return check.status === "passed"
        ? `\`${check.file}\` matches the code`
        : `${count(check.mismatches.length, "mismatch", "mismatches")} with \`${check.file}\``;
    case "boundaries":
      return check.status === "passed"
        ? "every relationship between components is declared"
        : `${count(check.undeclared.length, "relationship")} the target doesn't declare`;
    case "deployment": {
      const differ = check.added.length + check.removed.length + check.drifted.length;
      return check.status === "passed"
        ? `the Terraform matches the target's ${check.environment} deployment`
        : `${count(differ, "node")} ${differ === 1 ? "differs" : "differ"} from the target's ${check.environment} deployment`;
    }
    case "coverage": {
      const covered = check.criteria.filter((criterion) => criterion.status === "covered").length;
      return `${covered} of ${count(check.criteria.length, "criterion", "criteria")} covered`;
    }
    case "paths": {
      const tests = check.views.flatMap((view) => view.tests);
      const unmatched = tests.filter((test) => test.status === "unmatched").length;
      return check.status === "passed"
        ? `${count(tests.length, "tagged test")} ${tests.length === 1 ? "follows its" : "follow their"} issue's dynamic view`
        : unmatched > 0
          ? `${unmatched} of ${count(tests.length, "tagged test")} off their issue's dynamic view`
          : (check.views.find((view) => view.status === "failed")?.reason ?? "");
    }
    case "surplus": {
      const functions = check.untraced.reduce((sum, file) => sum + file.functions.length, 0);
      return check.status === "passed"
        ? "every source file is in a component"
        : [
            ...(check.outside.length > 0 ? [`${count(check.outside.length, "file")} outside every component`] : []),
            ...(functions > 0 ? [`${count(functions, "exported function")} no tagged test calls`] : []),
          ].join(", ");
    }
  }
}

// In target-change mode, the model diff: what the PR adds to, removes from and changes in the target.
function formatTargetChange(diff: ModelDiff | undefined, files: string[]): string {
  const lines = [
    "### ⚠️ Target change",
    "",
    "This PR changes the target, so merging it approves the change. Read the model diff before the code.",
    "",
    `Changed: ${files.map((file) => `\`${cell(file)}\``).join(", ")}`,
  ];
  const sections: Array<[string, Changes<{ id: string }>]> =
    diff === undefined
      ? []
      : [
          ["Elements", diff.elements],
          ["Relationships", diff.relationships],
          ["Dynamic views", diff.dynamicViews],
          ["Deployment", diff.deployment],
        ];
  const rows = sections
    .filter(([, changes]) => changes.added.length + changes.removed.length + changes.drifted.length > 0)
    .map(([name, changes]) => {
      const ids = (items: Array<{ id: string }>) => items.map((item) => `\`${cell(item.id)}\``).join(", ");
      const drifted = (items: Drift[]) =>
        items
          .map((item) => `\`${cell(item.id)}\` (${item.changes.map((change) => change.field).join(", ")})`)
          .join(", ");
      return `| ${name} | ${ids(changes.added)} | ${ids(changes.removed)} | ${drifted(changes.drifted)} |`;
    });
  lines.push(
    "",
    rows.length === 0
      ? "The model itself is unchanged."
      : ["| | Added | Removed | Drifted |", "| --- | --- | --- | --- |", ...rows].join("\n"),
  );
  return lines.join("\n");
}

// Text for a Markdown table cell, where a pipe would end the cell and a newline the row.
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

// Reads what the report needs beyond the check results from the repo and its git history.
export async function gatherReport(
  config: Config,
  base?: string,
): Promise<Pick<ReportInputs, "target" | "forked" | "targetFiles" | "files">> {
  const target = await loadModel(join(config.root, config.model), () => config);
  const fork = await forkPoint(config.root, base);
  const forked = await targetAtFork(config, fork, target);
  const model = posix.normalize(config.model.replaceAll("\\", "/"));
  const modelDir = posix.dirname(model);
  // Claims files are in .bearing/ too, but a claim describes a change rather than making one.
  const targetFiles = await changedPaths(config.root, fork, [
    modelDir === "." ? model : modelDir,
    ".bearing",
    `:(exclude)${claimsDir.replaceAll("\\", "/")}`,
    ".github/workflows",
  ]);
  const components = componentPaths(target);
  const files = (await changedSourceFiles(config.root, fork)).map((path) => {
    const component = componentOf(path, components);
    return component === undefined ? { path } : { path, component };
  });
  return { target, forked, targetFiles, files };
}

export interface PostOptions {
  repository: string;
  pr: number;
  token: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

// Posts the comment on the PR, or edits Bearing's comment from an earlier run if it has one. Returns its URL.
export async function postComment(body: string, options: PostOptions): Promise<{ url: string; updated: boolean }> {
  const { repository, pr, token, env = process.env, fetch: fetchFn = fetch } = options;
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const call = async (method: string, url: string, payload?: object) => {
    const response = await fetchFn(url, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok) {
      throw new ReportError(`GitHub returned ${response.status} ${response.statusText} for ${method} ${url}`);
    }
    return response.json() as Promise<unknown>;
  };
  let existing: { id: number } | undefined;
  for (let page = 1; existing === undefined; page++) {
    const comments = (await call(
      "GET",
      `${api}/repos/${repository}/issues/${pr}/comments?per_page=100&page=${page}`,
    )) as Array<{ id: number; body?: string }>;
    existing = comments.find((comment) => comment.body?.startsWith(reportMarker));
    if (comments.length < 100) break;
  }
  const posted = (
    existing === undefined
      ? await call("POST", `${api}/repos/${repository}/issues/${pr}/comments`, { body })
      : await call("PATCH", `${api}/repos/${repository}/issues/comments/${existing.id}`, { body })
  ) as { html_url: string };
  return { url: posted.html_url, updated: existing !== undefined };
}

// The PR a GitHub Actions run is for: the event's pull request, or the number in `refs/pull/<n>/merge`.
export async function pullRequestNumber(env: NodeJS.ProcessEnv = process.env): Promise<number | undefined> {
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as {
        pull_request?: { number?: number };
      };
      if (typeof event.pull_request?.number === "number") return event.pull_request.number;
    } catch {
      // No readable event: fall back to the ref.
    }
  }
  const match = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "");
  return match === null ? undefined : Number(match[1]);
}

// The Actions run's page, which lists the artifacts it uploaded.
function runUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: run } = env;
  return server && repository && run ? `${server}/${repository}/actions/runs/${run}` : undefined;
}

export function reportCommand(): Command {
  return new Command("report")
    .description(
      "write the PR comment: a summary of every check, then one Mermaid overlay of the elements the PR adds, removes or drifts, then each failing check's details; in target-change mode the target's diff comes first. Prints it, and with --post puts it on the PR, updating Bearing's comment from an earlier run",
    )
    .argument("[issues...]", "the issues to check coverage for, as for `bearing check`")
    .option("--branch <name>", "the branch whose claims file to check; defaults to the current one")
    .option("--base <ref>", "the branch this one forked from; defaults to the remote's default branch, then main")
    .option(
      "--check <file>",
      "read the results `bearing check --json` wrote to this file instead of running the checks",
    )
    .option("--site <dir>", "export the PR's target as Structurizr's static site into this directory, and link to it")
    .option("--site-url <url>", "where the static site is published; defaults, in GitHub Actions, to the run's page")
    .option("--post", "post the comment on the pull request, or update Bearing's earlier one")
    .option("--pr <number>", "the pull request to post on; defaults, in GitHub Actions, to the event's")
    .action(async function (
      this: Command,
      issues: string[],
      options: {
        branch?: string;
        base?: string;
        check?: string;
        site?: string;
        siteUrl?: string;
        post?: boolean;
        pr?: string;
      },
    ) {
      const numbers = issues.map((issue) => /^#?(\d+)$/.exec(issue.trim())?.[1]);
      const bad = issues.find((_, index) => numbers[index] === undefined);
      if (bad !== undefined) this.error(`error: "${bad}" is not an issue number, e.g. 2 or '#2'`);
      if (options.pr !== undefined && !/^[1-9]\d*$/.test(options.pr)) {
        this.error(`error: "${options.pr}" is not a pull request number`);
      }
      try {
        const config = loadConfig();
        const checkOptions: CheckOptions = {
          ...(issues.length > 0 ? { issues: numbers.map(Number) } : {}),
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(options.base === undefined ? {} : { base: options.base }),
        };
        const check =
          options.check === undefined
            ? await runChecks(config, checkOptions)
            : (JSON.parse(await readFile(options.check, "utf8")) as CheckReport);
        const gathered = await gatherReport(config, options.base);
        if (options.site !== undefined) {
          await exportStaticSite(config, options.site);
          process.stderr.write(`Wrote the Structurizr static site to ${options.site}\n`);
        }
        const siteUrl = options.siteUrl ?? (options.site === undefined ? undefined : runUrl(process.env));
        const body = formatComment({ check, ...gathered, ...(siteUrl === undefined ? {} : { siteUrl }) });
        process.stdout.write(body);
        if (options.post === true) {
          const pr = options.pr === undefined ? await pullRequestNumber() : Number(options.pr);
          if (pr === undefined) throw new ReportError("can't tell which pull request to post on; pass --pr");
          const repository = await githubRepository(config.root, process.env);
          if (repository === undefined) {
            throw new ReportError(
              "can't tell which GitHub repository to post on; set GITHUB_REPOSITORY=owner/name, or add a GitHub origin remote",
            );
          }
          const token = await githubToken(process.env);
          if (token === undefined) {
            throw new ReportError(
              "no GitHub token to post the comment with; set GITHUB_TOKEN, or install the GitHub CLI and run `gh auth login`",
            );
          }
          const posted = await postComment(body, { repository, pr, token });
          process.stderr.write(`${posted.updated ? "Updated" : "Posted"} ${posted.url}\n`);
        }
      } catch (error) {
        if (
          error instanceof ConfigError ||
          error instanceof StructurizrError ||
          error instanceof DeriveError ||
          error instanceof TerraformError ||
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
