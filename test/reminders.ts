import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./basket.js";

export const remindersDir = join(import.meta.dirname, "fixtures", "reminders");

// The seeded branches, each an overlay on the clean repo. See test/fixtures/reminders/README.md.
export const remindersVariants = ["consumer-sends-sms", "reminder-text", "untraced-format"] as const;
export type RemindersVariant = (typeof remindersVariants)[number];

// Whether there's a go command to test the Go adapter with. CI always has one.
export const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Copies the reminder worker to a temp directory, with a variant's files laid over it, reading its target from the
// exported workspace JSON so no test runs Structurizr. Returns the copy's root.
export function copyReminders(variant?: RemindersVariant): string {
  const root = mkdtempSync(join(tmpdir(), `bearing-reminders-${variant ?? "main"}-`));
  cpSync(join(remindersDir, "repo"), root, { recursive: true });
  if (variant !== undefined) cpSync(join(remindersDir, "variants", variant), root, { recursive: true });
  cpSync(join(remindersDir, "workspace.json"), join(root, "architecture", "workspace.json"));
  const config = join(root, ".bearing", "config.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("workspace.dsl", "workspace.json"));
  return root;
}

// The reminder worker as a git repo with main committed and, given a variant, the variant committed on a branch of
// its name.
export function remindersRepo(variant?: RemindersVariant): string {
  const root = copyReminders();
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "main");
  if (variant !== undefined) {
    git(root, "checkout", "-q", "-b", variant);
    cpSync(join(remindersDir, "variants", variant), root, { recursive: true });
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", variant);
  }
  return root;
}
