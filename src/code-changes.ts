import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { languageOf } from "./lang/index.js";
import { declarationFile, testFile } from "./paths.js";

// Where a PR's code changes land, for the architecture page: the functional files it adds, changes and deletes, with
// the lines added and removed in each, from `git diff --numstat` against the fork point. See Code changes in #116.

export interface FileChange {
  // Repo-relative, with forward slashes.
  path: string;
  added: number;
  removed: number;
  // Git can't count lines in a binary file, so it counts as a changed file with no lines.
  binary?: true;
}

// Generated code and lockfiles, which a language's extractor may map but nobody writes by hand.
const generatedFile =
  /(^|\/)(generated|__generated__)\/|\.(generated|gen)\.[^/]+$|_pb2(_grpc)?\.pyi?$|\.pb(\.gw)?\.go$|_gen\.go$|\.min\.[cm]?js$/;
const lockFile =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock)$/;
// The markers generators write at the top of a file: Go's convention, and the `@generated` many tools use.
const generatedHeader = /^\/\/ Code generated .* DO NOT EDIT\.$|@generated\b/m;

// Functional code: a file a configured language's extractor maps, other than tests, declaration files, generated
// files and lockfiles. `head` is the start of the file, when it exists, to spot a generator's marker.
export function functionalFile(config: Pick<Config, "languages">, path: string, head?: string): boolean {
  return (
    languageOf(config, path) !== undefined &&
    !testFile.test(path) &&
    !declarationFile.test(path) &&
    !generatedFile.test(path) &&
    !lockFile.test(path) &&
    (head === undefined || !generatedHeader.test(head))
  );
}

// Whether a path in the working tree is a file, rather than gone or a directory, such as a linked node_modules.
const isFile = (root: string, path: string) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true;

// The first lines of a file in the working tree, or undefined if it isn't one.
function headOf(root: string, path: string): string | undefined {
  return isFile(root, path) ? readFileSync(join(root, path)).subarray(0, 1024).toString("utf8") : undefined;
}

// Parses `git diff --numstat -z --no-renames`: "<added>\t<removed>\t<path>\0" per file, "-" for a binary file's counts.
export function parseNumstat(output: string): FileChange[] {
  return output
    .split("\0")
    .filter((entry) => entry !== "")
    .flatMap((entry): FileChange[] => {
      const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
      if (match === null) return [];
      const [, added, removed, path] = match;
      if (added === "-" || removed === "-") return [{ path: path!, added: 0, removed: 0, binary: true }];
      return [{ path: path!, added: Number(added), removed: Number(removed) }];
    });
}

// The functional files the branch changes since the fork point, with their lines, sorted by path. Files not yet
// committed count too, every line added.
export async function codeChanges(config: Pick<Config, "root" | "languages">, fork: string): Promise<FileChange[]> {
  const changes = new Map(
    parseNumstat(await git(config.root, ["diff", "--numstat", "--no-renames", "--relative", "-z", fork])).map(
      (change) => [change.path, change],
    ),
  );
  for (const path of split(await git(config.root, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    if (changes.has(path) || !isFile(config.root, path) || !functionalFile(config, path)) continue;
    const content = readFileSync(join(config.root, path));
    if (content.includes(0)) {
      changes.set(path, { path, added: 0, removed: 0, binary: true });
    } else {
      const text = content.toString("utf8");
      const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      changes.set(path, { path, added: lines, removed: 0 });
    }
  }
  return [...changes.values()]
    .filter((change) => functionalFile(config, change.path, headOf(config.root, change.path)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Every functional file in the working tree, tracked or not, sorted: what tells a component with code from one with
// none yet.
export async function sourceFiles(config: Pick<Config, "root" | "languages">): Promise<string[]> {
  const files = split(await git(config.root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
  return [...new Set(files)]
    .filter((path) => isFile(config.root, path))
    .filter((path) => functionalFile(config, path, headOf(config.root, path)))
    .sort();
}

const split = (output: string) => output.split("\0").filter((entry) => entry !== "");

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (error, stdout) =>
      error === null ? resolve(stdout) : reject(error),
    );
  });
}
