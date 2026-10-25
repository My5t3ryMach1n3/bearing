import { execFile } from "node:child_process";
import type { Run } from "./structurizr.js";

// Finding the GitHub repository and a token to call its API with, for reading requirements and posting the PR
// comment. Each caller says what to do when there's none.

// "owner/name": $GITHUB_REPOSITORY in Actions, otherwise the origin remote. Undefined if neither is on GitHub.
export async function githubRepository(
  root: string,
  env: NodeJS.ProcessEnv,
  run: Run = runCommand,
): Promise<string | undefined> {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  let remote = "";
  try {
    const result = await run("git", ["-C", root, "remote", "get-url", "origin"]);
    if (result.code === 0) remote = result.output.trim();
  } catch {
    // No git: no repository.
  }
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote)?.[1];
}

// $GITHUB_TOKEN or $GH_TOKEN in CI, otherwise the token `gh` is logged in with. Undefined if there's none.
export async function githubToken(env: NodeJS.ProcessEnv, run: Run = runCommand): Promise<string | undefined> {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) return token;
  try {
    const result = await run("gh", ["auth", "token"]);
    if (result.code === 0 && result.output.trim() !== "") return result.output.trim();
  } catch {
    // No gh: no token.
  }
  return undefined;
}

// Runs a command and returns its stdout alone, so a token or URL isn't mixed with warnings.
export const runCommand: Run = (command, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error !== null && typeof error.code === "string") reject(error);
      else resolvePromise({ code: error === null ? 0 : Number(error.code ?? 1), output: stdout });
    });
  });
