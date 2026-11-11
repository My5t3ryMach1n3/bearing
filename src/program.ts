import { Command } from "commander";
import { checkCommand } from "./check.js";
import { claimCommand } from "./claims.js";
import { contextCommand } from "./context.js";
import { deriveCommand } from "./derive.js";
import { diffCommand } from "./diff.js";
import { guardCommand } from "./guard.js";
import { initCommand } from "./init.js";
import { pageCommand } from "./page.js";
import { postCommand } from "./post.js";
import { reportCommand } from "./report.js";
import { skillCommand } from "./skill.js";
import { testCommand } from "./test.js";
import { validateCommand } from "./validate.js";
import { version } from "./version.js";

// Subcommand factories, one per `bearing <command>`. Each issue that adds a command registers it here.
const commands: Array<() => Command> = [
  initCommand,
  diffCommand,
  contextCommand,
  validateCommand,
  skillCommand,
  deriveCommand,
  claimCommand,
  testCommand,
  checkCommand,
  reportCommand,
  pageCommand,
  guardCommand,
  postCommand,
];

export function createProgram(): Command {
  const program = new Command("bearing")
    .description(
      "Architecture used to control agentic engineering: check every PR against an approved C4 target architecture.",
    )
    .version(version, "-v, --version", "print the Bearing version")
    .helpOption("-h, --help", "print help")
    .showHelpAfterError()
    .action(() => program.help());
  for (const command of commands) program.addCommand(command());
  return program;
}
