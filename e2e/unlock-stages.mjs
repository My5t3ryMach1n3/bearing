// Opens an `e2e` issue for each stage in e2e/stages/ whose required Bearing issues are all closed.
// Safe to re-run: a stage whose issue already exists, open or closed, is skipped.
// Needs `gh` authenticated for the repo. Set DRY_RUN=1 to print instead of creating issues.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.env.GITHUB_REPOSITORY ?? "My5t3ryMach1n3/bearing";
const assignee = process.env.GITHUB_REPOSITORY_OWNER ?? repo.split("/")[0];
const dryRun = Boolean(process.env.DRY_RUN);
const stagesDir = join(import.meta.dirname, "stages");
const scenarioUrl = `https://github.com/${repo}/blob/main/e2e/README.md`;

const gh = (...args) => execFileSync("gh", [...args, "-R", repo], { encoding: "utf8" });

function parseStage(file) {
  const text = readFileSync(join(stagesDir, file), "utf8");
  const [, frontMatter, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const field = (name) => frontMatter.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))[1].trim();
  return {
    number: parseInt(file, 10),
    title: field("title").replace(/^"(.*)"$/, "$1"),
    requires: JSON.parse(field("requires")),
    body: body.trim(),
  };
}

const stages = readdirSync(stagesDir).filter((f) => f.endsWith(".md")).sort().map(parseStage);
const closed = new Set(
  JSON.parse(gh("issue", "list", "--state", "closed", "--limit", "1000", "--json", "number")).map((i) => i.number),
);
const opened = new Set(
  JSON.parse(gh("issue", "list", "--label", "e2e", "--state", "all", "--limit", "200", "--json", "title"))
    .map((i) => i.title.match(/^E2E stage (\d+):/)?.[1])
    .filter(Boolean)
    .map(Number),
);

const ready = stages.filter((s) => !opened.has(s.number) && s.requires.every((n) => closed.has(n)));
if (ready.length && !dryRun) {
  gh("label", "create", "e2e", "--color", "0e8a16", "--description", "Shelf end-to-end scenario stage", "--force");
}
for (const stage of ready) {
  const title = `E2E stage ${stage.number}: ${stage.title}`;
  const unlockedBy = stage.requires.length ? `Unlocked by ${stage.requires.map((n) => `#${n}`).join(", ")}.` : "";
  const body = `${stage.body}\n\n---\n${unlockedBy} Part of the [Shelf scenario](${scenarioUrl}). Close this issue when the checklist is done; file anything Bearing got wrong as its own issue and link it here.`;
  if (dryRun) {
    console.log(`would open: ${title}`);
    continue;
  }
  const url = gh("issue", "create", "--title", title, "--label", "e2e", "--assignee", assignee, "--body", body).trim();
  console.log(`opened ${url}`);
}
if (!ready.length) console.log("no new stages unlocked");
