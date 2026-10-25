import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Command } from "commander";
import { ConfigError, loadConfig, type Config } from "./config.js";

// Where `bearing skill --install` puts the design skill: the cross-agent skills folder. Nothing writes it unasked.
export const skillPath = ".agents/skills/bearing-design/SKILL.md";

const template = new URL("../templates/skills/bearing-design/SKILL.md", import.meta.url);

// The requirements-to-model skill, with the model and ADR paths from the config.
export function designSkill(config: Config): string {
  return readFileSync(template, "utf8")
    .replaceAll("{{model}}", config.model)
    .replaceAll("{{adrs}}", posix.join(posix.dirname(config.model), "adrs"));
}

export type InstallOutcome = "installed" | "unchanged" | "edited";

// Writes the skill into the repo. Never replaces a copy that differs, which may hold the team's edits, unless `force`.
export function installSkill(config: Config, force = false): InstallOutcome {
  const file = join(config.root, skillPath);
  const text = designSkill(config);
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8");
    if (existing === text) return "unchanged";
    if (!force) return "edited";
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return "installed";
}

export function skillCommand(): Command {
  return new Command("skill")
    .description("print the skill agents follow to design the target, or install it into the repo")
    .option("--install", `write it to ${skillPath}, for agents that load skills`)
    .option("--force", "with --install, replace a copy that differs")
    .action(function (this: Command, options: { install?: boolean; force?: boolean }) {
      try {
        const config = loadConfig();
        if (options.install !== true) {
          process.stdout.write(designSkill(config));
          return;
        }
        const outcome = installSkill(config, options.force === true);
        if (outcome === "edited") {
          this.error(`error: ${skillPath} differs from Bearing's copy; pass --force to replace it`);
        }
        process.stdout.write(
          outcome === "installed" ? `Installed ${skillPath}\n` : `${skillPath} is already up to date\n`,
        );
      } catch (error) {
        if (error instanceof ConfigError) this.error(`error: ${error.message}`);
        throw error;
      }
    });
}
