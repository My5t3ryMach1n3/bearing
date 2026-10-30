import { join } from "node:path";
import { Command } from "commander";
import {
  baseBranch,
  changedBetween,
  changedPaths,
  changedSourceFiles,
  claimFile,
  ClaimError,
  currentBranch,
  forkPoint,
  issuesInBranch,
  modelPathspec,
  readClaim,
  targetAt,
  type Claim,
} from "./claims.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import {
  CoverageError,
  criteriaCoverage,
  formatCoverage,
  readTestRecords,
  type CriterionCoverage,
} from "./coverage.js";
import { deriveImports, DeriveError, type ImportGraph, type ImportRelationship, type ImportSite } from "./derive.js";
import { diffModels, loadModel, type Drift } from "./diff.js";
import type { Model } from "./model.js";
import { componentOf, componentPaths } from "./paths.js";
import { loadRequirements, RequirementsError, type Requirement } from "./requirements.js";
import { StructurizrError } from "./structurizr.js";
import { checkSurplus, closedComponents, formatSurplus, type SurplusResult } from "./surplus.js";
import { readSpanRecords, tracesDir } from "./test.js";
import { checkTracePaths, formatTracePaths, type ViewPaths } from "./trace-paths.js";
import { validateModel, type Problem } from "./validate.js";
import {
  deriveTerraform,
  TerraformError,
  terraformModel,
  type TerraformGraph,
  type TerraformResource,
} from "./terraform.js";

// The checks `bearing check` runs. The blocking ones, Target valid, Target change, Claim, Boundaries, Deployment,
// Criteria coverage and Trace paths, each pass, fail or are skipped when there's nothing for them to check. The advisory one, Surplus,
// passes, is flagged or is skipped when turned off, and never fails the run: its result sets `bearing/advisory`. This
// is the JSON `bearing check --json` prints for `bearing report`. See the Checks section of docs/product-spec.md.
export interface CheckReport {
  // False if any blocking check failed.
  passed: boolean;
  checks: [
    ValidCheck,
    TargetCheck,
    ClaimCheck,
    BoundariesCheck,
    DeploymentCheck,
    CoverageCheck,
    PathsCheck,
    SurplusCheck,
  ];
}

export type CheckStatus = "passed" | "failed" | "skipped";

interface CheckBase {
  status: CheckStatus;
  blocking: true;
  // Why the check was skipped.
  reason?: string;
}

export interface SurplusCheck extends SurplusResult {
  check: "surplus";
  status: "passed" | "flagged" | "skipped";
  blocking: false;
  reason?: string;
}

// The checked target against Bearing's rules, as `bearing validate` checks it. Structurizr's own validation already
// passed, or the target wouldn't have loaded.
export interface ValidCheck extends CheckBase {
  check: "valid";
  // The model file, relative to the repo root.
  model: string;
  problems: Problem[];
}

// Whether a branch that proposes a target change is built on the base branch's current target. The first proposal
// to merge wins: a later one fails until it's rebased onto the new target.
export interface TargetCheck extends CheckBase {
  check: "target";
  // The branch it forked from, e.g. "main".
  base: string;
  // The target's files the branch changes: its proposal. Empty when it doesn't change the target.
  proposed: string[];
  // The target's files the base branch changed after the fork point.
  moved: string[];
}

export interface ClaimCheck extends CheckBase {
  check: "claim";
  // The claims file, relative to the repo root, when the branch has one.
  file?: string;
  mismatches: ClaimMismatch[];
}

// Where the claims file and the as-built model disagree.
export type ClaimMismatch =
  // The code makes a relationship the target didn't have at the fork point, and the claim doesn't add it.
  | { kind: "unclaimed"; id: string; imports: ImportSite[] }
  // The claim removes an element or relationship the code still has: the relationship's imports, or the files
  // under the component's path.
  | { kind: "not-removed"; id: string; imports?: ImportSite[]; files?: string[] }
  // A source file the branch changes that the claim doesn't list.
  | { kind: "unlisted-file"; path: string; component?: string }
  // A file the claim lists that the branch doesn't change.
  | { kind: "unchanged-file"; path: string }
  // A file the claim gives a different component from the one whose path holds it.
  | { kind: "wrong-component"; path: string; claimed?: string; component?: string };

export interface BoundariesCheck extends CheckBase {
  check: "boundaries";
  // Relationships between components that the target doesn't declare, with the imports that make them.
  undeclared: ImportRelationship[];
}

export interface DeploymentCheck extends CheckBase {
  check: "deployment";
  environment?: string;
  // Nodes in the Terraform that the target doesn't have.
  added: Array<{ id: string; technology: string; resource: TerraformResource }>;
  // Target nodes of a mapped technology with no resource.
  removed: Array<{ id: string; name: string; technology: string }>;
  // Nodes in both whose instance counts differ.
  drifted: Drift[];
  // Resources Bearing can't map, and modules it doesn't follow. Listed, never failed.
  unknown: TerraformResource[];
}

export interface CoverageCheck extends CheckBase {
  check: "coverage";
  // The issues checked, e.g. ["#2"].
  issues: string[];
  criteria: CriterionCoverage[];
  // How many test results the last `bearing test` recorded.
  recorded: number;
}

export interface PathsCheck extends CheckBase {
  check: "paths";
  // The issues checked, as for coverage.
  issues: string[];
  // Each issue's dynamic view against the traces of its passing tagged tests.
  views: ViewPaths[];
}

const pairOf = (relationship: { source: string; destination: string }) =>
  `${relationship.source}->${relationship.destination}`;
// A relationship's ID without the description that tells apart two between the same pair: "a->b[save()]" is "a->b".
const withoutDescription = (id: string) => id.replace(/\[.*\]$/, "");

// Tests the claim against the as-built model. The claim describes the branch's change to the target, so it's read
// on top of the target at the fork point: every relationship the code makes must be in that target or in the
// claim's `model.added`, nothing the claim removes may still be in the code, and `files` must list the source files
// the branch changes with the components whose paths hold them.
//
// A claimed addition the code doesn't make yet isn't a mismatch: the target may lead the code.
export function checkClaim(
  claim: Claim,
  inputs: { forked: Model; target: Model; graph: ImportGraph; changed: string[] },
): ClaimMismatch[] {
  const { forked, target, graph, changed } = inputs;
  const declared = new Set([...forked.relationships.values()].map(pairOf));
  const added = new Set(claim.model.added.map(withoutDescription));
  const removed = new Set(claim.model.removed.map(withoutDescription));
  const mismatches: ClaimMismatch[] = [];

  for (const relationship of graph.relationships) {
    if (removed.has(relationship.id)) {
      mismatches.push({ kind: "not-removed", id: relationship.id, imports: relationship.imports });
    } else if (!declared.has(relationship.id) && !added.has(relationship.id)) {
      mismatches.push({ kind: "unclaimed", id: relationship.id, imports: relationship.imports });
    }
  }
  // A removed component still has code if files remain under the path it had, whoever owns them now.
  const forkedPaths = componentPaths(forked);
  const files = [...graph.components.flatMap((component) => component.files), ...graph.unmapped];
  for (const id of claim.model.removed) {
    const path = forkedPaths.find((component) => component.id === id)?.path;
    if (path === undefined) continue;
    const remaining = files.filter((file) => componentOf(file, [{ id, path }]) !== undefined).sort();
    if (remaining.length > 0) mismatches.push({ kind: "not-removed", id, files: remaining });
  }

  const components = componentPaths(target);
  const listed = new Map(claim.files.map((file) => [file.path, file.component]));
  for (const path of changed) {
    const component = componentOf(path, components);
    if (!listed.has(path)) {
      mismatches.push(
        component === undefined ? { kind: "unlisted-file", path } : { kind: "unlisted-file", path, component },
      );
    } else if (listed.get(path) !== component) {
      const mismatch: ClaimMismatch = { kind: "wrong-component", path };
      if (listed.get(path) !== undefined) mismatch.claimed = listed.get(path);
      if (component !== undefined) mismatch.component = component;
      mismatches.push(mismatch);
    }
  }
  const changedSet = new Set(changed);
  for (const file of claim.files) {
    if (!changedSet.has(file.path)) mismatches.push({ kind: "unchanged-file", path: file.path });
  }
  return mismatches;
}

// Relationships between components that the code makes and the target doesn't declare. Anything inside one
// component passes, since imports within a component make no relationship.
export function checkBoundaries(target: Model, graph: ImportGraph): ImportRelationship[] {
  const declared = new Set([...target.relationships.values()].map(pairOf));
  return graph.relationships.filter((relationship) => !declared.has(relationship.id));
}

// The Terraform's deployment nodes against the target's deployment view: nodes it adds, target nodes it has no
// resource for, and instance counts that differ.
export function checkDeployment(
  target: Model,
  graph: TerraformGraph,
): Pick<DeploymentCheck, "environment" | "added" | "removed" | "drifted" | "unknown"> {
  const diff = diffModels(target, terraformModel(target, graph)).deployment;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    environment: graph.environment,
    added: diff.added.map(({ id }) => {
      const node = nodes.get(id)!;
      return { id, technology: node.technology, resource: node.resource };
    }),
    removed: diff.removed.map(({ id, name, technology }) => ({ id, name, technology })),
    drifted: diff.drifted,
    unknown: graph.unknown,
  };
}

// The target a branch is checked against. A branch that changes the target's files is checked against its own,
// proposed target; any other against the base branch's current one, so it meets every target change merged since
// it forked.
export interface CheckedTarget {
  target: Model;
  // The target the branch's change starts from: the one at the fork point when it proposes a change, otherwise
  // `target` itself, the same object.
  forked: Model;
  // The commit the branch forked from.
  fork: string;
  base: string;
  proposed: string[];
  moved: string[];
}

// Works out the target to check against. Structurizr runs a second time only when the branch proposes a change, for
// the target at the fork point, or when it doesn't and the base branch's target has moved, for that one.
export async function checkedTarget(config: Config, base?: string): Promise<CheckedTarget> {
  const branch = await baseBranch(config.root, base);
  const fork = await forkPoint(config.root, branch);
  const pathspec = modelPathspec(config);
  const proposed = await changedPaths(config.root, fork, [pathspec]);
  const moved = await changedBetween(config.root, fork, branch, [pathspec]);
  const onDisk = await loadModel(join(config.root, config.model), () => config);
  if (proposed.length > 0) {
    return { target: onDisk, forked: await targetAt(config, fork), fork, base: branch, proposed, moved };
  }
  const target = moved.length === 0 ? onDisk : await targetAt(config, branch);
  return { target, forked: target, fork, base: branch, proposed, moved };
}

export interface CheckOptions {
  // The issues to check coverage for; by default the claim's, or failing that the branch name's.
  issues?: number[];
  branch?: string;
  base?: string;
}

// Runs every check against the code as it is on disk and the target `checkedTarget` picks.
export async function runChecks(config: Config, options: CheckOptions = {}): Promise<CheckReport> {
  const { target, forked, fork, base, proposed, moved } = await checkedTarget(config, options.base);
  const graph = deriveImports(config, target);
  const branch = options.branch ?? (await currentBranch(config.root));
  const claim = await readClaim(config, branch);

  // Read from GitHub at most once, and only by the checks that need them.
  let loaded: Promise<Requirement[]> | undefined;
  const requirements = () => (loaded ??= loadRequirements(config));

  const problems = validateModel(target, await requirements(), config.tests.tag);
  const validCheck: ValidCheck = {
    check: "valid",
    status: problems.length === 0 ? "passed" : "failed",
    blocking: true,
    model: config.model,
    problems,
  };

  const targetCheck: TargetCheck =
    proposed.length === 0
      ? {
          check: "target",
          status: "skipped",
          blocking: true,
          reason: `the branch doesn't change the target, so it's checked against ${base}'s`,
          base,
          proposed,
          moved,
        }
      : {
          check: "target",
          status: moved.length === 0 ? "passed" : "failed",
          blocking: true,
          base,
          proposed,
          moved,
        };

  let claimCheck: ClaimCheck;
  if (claim === undefined) {
    claimCheck = {
      check: "claim",
      status: "skipped",
      blocking: true,
      reason: `no claims file for ${branch}; run \`bearing claim\` to write one`,
      mismatches: [],
    };
  } else {
    const changed = await changedSourceFiles(config.root, fork);
    const mismatches = checkClaim(claim, { forked, target, graph, changed });
    claimCheck = {
      check: "claim",
      status: mismatches.length === 0 ? "passed" : "failed",
      blocking: true,
      file: toPosix(claimFile(branch)),
      mismatches,
    };
  }

  const undeclared = checkBoundaries(target, graph);
  const boundaries: BoundariesCheck = {
    check: "boundaries",
    status: undeclared.length === 0 ? "passed" : "failed",
    blocking: true,
    undeclared,
  };

  let deployment: DeploymentCheck;
  if (config.iac.terraform === undefined) {
    deployment = {
      check: "deployment",
      status: "skipped",
      blocking: true,
      reason: '"iac.terraform" is not set in .bearing/config.yaml',
      added: [],
      removed: [],
      drifted: [],
      unknown: [],
    };
  } else {
    const result = checkDeployment(target, deriveTerraform(config, target));
    const failed = result.added.length + result.removed.length + result.drifted.length > 0;
    deployment = { check: "deployment", status: failed ? "failed" : "passed", blocking: true, ...result };
  }

  const issues = options.issues?.map((issue) => `#${issue}`) ?? claim?.issues ?? issuesInBranch(branch);
  let coverage: CoverageCheck;
  let paths: PathsCheck;
  if (issues.length === 0) {
    const reason =
      claim === undefined
        ? "no issues: the branch has no claims file and its name names none"
        : `no issues: ${toPosix(claimFile(branch))} lists none`;
    coverage = { check: "coverage", status: "skipped", blocking: true, reason, issues, criteria: [], recorded: 0 };
    paths = { check: "paths", status: "skipped", blocking: true, reason, issues, views: [] };
  } else {
    const tests = readTestRecords(join(config.root, tracesDir));
    const numbers = issues.map((issue) => Number(issue.slice(1)));
    const criteria = criteriaCoverage(config, await requirements(), numbers, tests);
    coverage = {
      check: "coverage",
      status: criteria.every((criterion) => criterion.status === "covered") ? "passed" : "failed",
      blocking: true,
      issues,
      criteria,
      recorded: tests.length,
    };
    const spans = readSpanRecords(join(config.root, tracesDir));
    const views = checkTracePaths(config, {
      target,
      requirements: await requirements(),
      issues: numbers,
      tests,
      spans,
    });
    paths = views.some((view) => view.status === "failed")
      ? { check: "paths", status: "failed", blocking: true, issues, views }
      : views.some((view) => view.status === "passed")
        ? { check: "paths", status: "passed", blocking: true, issues, views }
        : {
            check: "paths",
            status: "skipped",
            blocking: true,
            reason: "no issue has a passing tagged test to compare with its dynamic view",
            issues,
            views,
          };
  }

  let surplus: SurplusCheck;
  if (config.checks.surplus === "off") {
    const reason = '"checks.surplus" is off in .bearing/config.yaml';
    surplus = {
      check: "surplus",
      status: "skipped",
      blocking: false,
      reason,
      outside: [],
      closed: [],
      untraced: [],
      traced: false,
    };
  } else {
    const spans = readSpanRecords(join(config.root, tracesDir));
    const result = checkSurplus(config.root, graph, spans, closedComponents(target, await requirements()));
    const flagged = result.outside.length + result.closed.length + result.untraced.length > 0;
    surplus = { check: "surplus", status: flagged ? "flagged" : "passed", blocking: false, ...result };
  }

  const checks: CheckReport["checks"] = [
    validCheck,
    targetCheck,
    claimCheck,
    boundaries,
    deployment,
    coverage,
    paths,
    surplus,
  ];
  return { passed: checks.every((check) => check.status !== "failed"), checks };
}

export const checkTitles = {
  valid: "Target valid",
  target: "Target change",
  claim: "Claim",
  boundaries: "Boundaries",
  deployment: "Deployment",
  coverage: "Criteria coverage",
  paths: "Trace paths",
  surplus: "Surplus",
};

export function formatReport(report: CheckReport): string {
  const sections = report.checks.map(formatCheck);
  const failed = report.checks.filter((check) => check.status === "failed").map((check) => checkTitles[check.check]);
  const flagged = report.checks.filter((check) => check.status === "flagged").map((check) => checkTitles[check.check]);
  let verdict =
    failed.length === 0
      ? "All blocking checks passed."
      : `${failed.length} blocking ${failed.length === 1 ? "check" : "checks"} failed: ${failed.join(", ")}.`;
  if (flagged.length > 0) verdict += ` Advisory, not blocking: ${flagged.join(", ")} flagged.`;
  return [...sections, `${verdict}\n`].join("\n");
}

// One check's result as `bearing check` prints it.
export function formatCheck(check: CheckReport["checks"][number]): string {
  if (check.status === "skipped") return `${checkTitles[check.check]}: skipped, ${check.reason}\n`;
  switch (check.check) {
    case "valid":
      return formatValidCheck(check);
    case "target":
      return formatTargetCheck(check);
    case "claim":
      return formatClaimCheck(check);
    case "boundaries":
      return formatBoundaries(check);
    case "deployment":
      return formatDeployment(check);
    case "coverage":
      return formatCoverage(check.criteria, check.recorded);
    case "paths":
      return formatTracePaths(check.views);
    case "surplus":
      return formatSurplus(check);
  }
}

function formatValidCheck(check: ValidCheck): string {
  if (check.status === "passed") return `Target valid: passed, ${check.model} follows Bearing's rules\n`;
  return [
    `Target valid: failed, ${check.model} breaks ${check.problems.length} Bearing ${check.problems.length === 1 ? "rule" : "rules"}`,
    ...check.problems.map((problem) => `  ${problem.id}: ${problem.message}`),
    "",
  ].join("\n");
}

function formatTargetCheck(check: TargetCheck): string {
  if (check.status === "passed") return `Target change: passed, proposed on ${check.base}'s current target\n`;
  return [
    `Target change: failed, ${check.base}'s target changed after this branch forked, so the proposal isn't built on it`,
    ...check.moved.map((file) => `  ${file}`),
    `  The first target change to merge wins. Rebase onto ${check.base}, fold its change into this one, and rerun.`,
    "",
  ].join("\n");
}

function formatClaimCheck(check: ClaimCheck): string {
  if (check.status === "passed") return `Claim: passed, ${check.file} matches the code\n`;
  const lines = [`Claim: failed, ${check.file} doesn't match the code`];
  for (const mismatch of check.mismatches) {
    switch (mismatch.kind) {
      case "unclaimed":
        lines.push(
          `  ${mismatch.id}: the code makes it, but the target didn't have it and the claim doesn't add it`,
          ...mismatch.imports.map(formatImport),
        );
        break;
      case "not-removed":
        lines.push(
          `  ${mismatch.id}: the claim removes it, but the code still has it`,
          ...(mismatch.imports ?? []).map(formatImport),
          ...(mismatch.files ?? []).map((file) => `    ${file}`),
        );
        break;
      case "unlisted-file":
        lines.push(`  ${mismatch.path}: changed, but not in the claim's files; rerun \`bearing claim\``);
        break;
      case "unchanged-file":
        lines.push(`  ${mismatch.path}: in the claim's files, but the branch doesn't change it`);
        break;
      case "wrong-component":
        lines.push(
          `  ${mismatch.path}: claimed for ${mismatch.claimed ?? "no component"}, but ${mismatch.component === undefined ? "no component's path holds it" : `it's in ${mismatch.component}'s path`}`,
        );
        break;
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatBoundaries(check: BoundariesCheck): string {
  if (check.status === "passed") return "Boundaries: passed, every relationship between components is declared\n";
  const lines = ["Boundaries: failed, the code makes relationships the target doesn't declare"];
  for (const relationship of check.undeclared) {
    lines.push(`  ${relationship.id}`, ...relationship.imports.map(formatImport));
  }
  lines.push("  Fix the code within the target, or propose the relationship as a target change in the model.");
  return `${lines.join("\n")}\n`;
}

function formatDeployment(check: DeploymentCheck): string {
  const lines =
    check.status === "passed"
      ? [`Deployment: passed, the Terraform matches the target's ${check.environment} deployment`]
      : [`Deployment: failed, the Terraform doesn't match the target's ${check.environment} deployment`];
  for (const node of check.added) {
    lines.push(
      `  ${node.id}: ${node.technology} in the Terraform, but not in the target (${node.resource.file}:${node.resource.line})`,
    );
  }
  for (const node of check.removed) {
    lines.push(`  ${node.id}: ${node.technology} in the target, but no resource in the Terraform`);
  }
  for (const drift of check.drifted) {
    const changes = drift.changes.map(
      (change) =>
        `${change.field} ${String(change.from ?? "unset")} in the target, ${String(change.to ?? "unset")} in the Terraform`,
    );
    lines.push(`  ${drift.id}: ${changes.join("; ")}`);
  }
  if (check.unknown.length > 0) {
    lines.push("  Not compared, as Bearing doesn't map them:");
    for (const resource of check.unknown) lines.push(`    ${resource.address} (${resource.file}:${resource.line})`);
  }
  return `${lines.join("\n")}\n`;
}

function formatImport(site: ImportSite): string {
  return `    ${site.file}:${site.line} imports "${site.module}"`;
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

export function checkCommand(): Command {
  return new Command("check")
    .description(
      "run the blocking checks: the target against Bearing's rules (Target valid), a target change against the base branch's current target (Target change), the claims file against the code (Claim), relationships between components against the target (Boundaries), the Terraform against the target's deployment view (Deployment), criteria coverage from `bearing test`, and each tested issue's traces against its dynamic view (Trace paths); then flags code outside every component or reached by no tagged test (Surplus, advisory); exits non-zero if a blocking check fails",
    )
    .argument("[issues...]", "the issues to check coverage for, e.g. 2 4; defaults to the claims file's")
    .option("--branch <name>", "the branch whose claims file to check; defaults to the current one")
    .option("--base <ref>", "the branch this one forked from; defaults to the remote's default branch, then main")
    .option("--json", "print the results as JSON instead of text")
    .action(async function (
      this: Command,
      issues: string[],
      options: { branch?: string; base?: string; json?: boolean },
    ) {
      const numbers = issues.map((issue) => /^#?(\d+)$/.exec(issue.trim())?.[1]);
      const bad = issues.find((_, index) => numbers[index] === undefined);
      if (bad !== undefined) this.error(`error: "${bad}" is not an issue number, e.g. 2 or '#2'`);
      try {
        const config = loadConfig();
        const report = await runChecks(config, {
          ...(issues.length > 0 ? { issues: numbers.map(Number) } : {}),
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(options.base === undefined ? {} : { base: options.base }),
        });
        process.stdout.write(options.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
        if (!report.passed) process.exitCode = 1;
      } catch (error) {
        if (
          error instanceof ConfigError ||
          error instanceof StructurizrError ||
          error instanceof DeriveError ||
          error instanceof TerraformError ||
          error instanceof ClaimError ||
          error instanceof RequirementsError ||
          error instanceof CoverageError
        ) {
          this.error(`error: ${error.message}`);
        }
        throw error;
      }
    });
}
