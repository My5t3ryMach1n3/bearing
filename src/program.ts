import { Command } from "commander";
import { contextCommand } from "./context.js";
import { diffCommand } from "./diff.js";
import { initCommand } from "./init.js";
import { version } from "./version.js";

// Subcommand factories, one per `bearing <command>`. Each issue that adds a command registers it here.
const commands: Array<() => Command> = [initCommand, diffCommand, contextCommand];

export function createProgram(): Command {
  const program = new Command("bearing")
    .description("GitOps for architecture: reconcile every PR against an approved C4 target architecture.")
    .version(version, "-v, --version", "print the Bearing version")
    .helpOption("-h, --help", "print help")
    .showHelpAfterError()
    .action(() => program.help());
  for (const command of commands) program.addCommand(command());
  return program;
}
