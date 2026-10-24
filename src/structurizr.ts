import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "./config.js";

// Bearing calls Structurizr once, to turn the DSL into workspace JSON; everything after that is TypeScript.
// Both runners are pinned to the same release so they produce the same JSON. Bump all three together.
export const structurizrVersion = "2026.09.19";
export const dockerImage = `structurizr/structurizr:${structurizrVersion}@sha256:721136283c2f9cf1ba69037bc9de136c579d66fdcb2d771cb60546ec68def1a5`;
export const war = {
  url: `https://download.structurizr.com/structurizr-${structurizrVersion}.war`,
  sha256: "ac1a2806e246364b88261a542a36ca7f3006ef48e5de68830afa8672f58690f1",
};

// Workspace JSON as Structurizr exports it. modelFromWorkspace() in model.ts reads it into the internal model.
export type Workspace = Record<string, unknown>;

// Runs a command to completion. Rejects only if it can't start, e.g. ENOENT when it isn't installed.
export type Run = (command: string, args: string[]) => Promise<{ code: number; output: string }>;

export interface LoadWorkspaceOptions {
  cacheDir?: string;
  run?: Run;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export class StructurizrError extends Error {
  constructor(
    message: string,
    // Repo-relative path and 1-based line of the problem, when Structurizr reports one.
    readonly file?: string,
    readonly line?: number,
  ) {
    super(file === undefined ? message : `${file}${line === undefined ? "" : `:${line}`}: ${message}`);
    this.name = "StructurizrError";
  }
}

// Where the model directory is mounted inside the Docker container.
const mountPoint = "/workspace";

export function defaultCacheDir(): string {
  const env = process.env;
  if (env.BEARING_CACHE_DIR) return env.BEARING_CACHE_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "bearing", "cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "bearing");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "bearing");
}

// Converts the configured DSL to workspace JSON, reusing a cached conversion when the model hasn't changed.
export async function loadWorkspace(config: Config, options: LoadWorkspaceOptions = {}): Promise<Workspace> {
  const {
    cacheDir = defaultCacheDir(),
    run = spawnRun,
    log = (message) => process.stderr.write(`${message}\n`),
  } = options;
  const dsl = resolve(config.root, config.model);
  if (!existsSync(dsl)) {
    throw new StructurizrError(`model not found; check "model" in .bearing/config.yaml`, config.model);
  }
  const modelDir = dirname(dsl);
  const cached = join(cacheDir, "workspaces", `${await hashModel(modelDir, dsl)}.json`);
  if (existsSync(cached)) return JSON.parse(await readFile(cached, "utf8")) as Workspace;

  const out = await mkdtemp(join(tmpdir(), "bearing-structurizr-"));
  try {
    let command: string;
    let args: string[];
    if (config.structurizr.runner === "docker") {
      if ((await tryRun(run, "docker", ["image", "inspect", dockerImage])).code !== 0) {
        log(`Pulling Structurizr ${structurizrVersion} (${dockerImage.split("@")[0]})...`);
      }
      const user = process.getuid && process.getgid ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
      const workspace = `${mountPoint}/${basename(dsl)}`;
      command = "docker";
      args = ["run", "--rm", ...user, "-v", `${modelDir}:${mountPoint}:ro`, "-v", `${out}:/out`, dockerImage];
      args.push("export", "-w", workspace, "-f", "json", "-o", "/out");
    } else {
      command = "java";
      args = ["-jar", await ensureWar(cacheDir, options.fetch ?? fetch, log), "export", "-w", dsl];
      args.push("-f", "json", "-o", out);
    }
    const { code, output } = await tryRun(run, command, args);
    if (code !== 0) throw failure(output, config, modelDir);
    const file = (await readdir(out)).find((name) => name.endsWith(".json"));
    if (file === undefined) throw new StructurizrError(`Structurizr wrote no workspace JSON:\n${output.trim()}`);
    const text = await readFile(join(out, file), "utf8");
    await writeAtomically(cached, text);
    return JSON.parse(text) as Workspace;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

// Hashes everything under the model's directory, since the DSL can pull in files with !include, !docs and !adrs.
// Includes from outside that directory are not supported: Docker only mounts the model's directory.
async function hashModel(modelDir: string, dsl: string): Promise<string> {
  const hash = createHash("sha256").update(`${structurizrVersion}\0${basename(dsl)}\0`);
  const files = (await readdir(modelDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (file) =>
        !relative(modelDir, file)
          .split(sep)
          .some((part) => part.startsWith(".") || part === "node_modules"),
    )
    .sort();
  for (const file of files) {
    const content = await readFile(file);
    hash.update(`${relative(modelDir, file).split(sep).join("/")}\0${content.length}\0`).update(content);
  }
  return hash.digest("hex");
}

// Downloads the pinned .war into the cache once, refusing it unless its checksum matches.
async function ensureWar(cacheDir: string, fetchWar: typeof fetch, log: (message: string) => void): Promise<string> {
  const path = join(cacheDir, `structurizr-${structurizrVersion}.war`);
  if (existsSync(path)) return path;
  log(`Downloading Structurizr ${structurizrVersion} from ${war.url}...`);
  const response = await fetchWar(war.url);
  if (!response.ok || response.body === null) {
    throw new StructurizrError(`couldn't download ${war.url}: HTTP ${response.status}`);
  }
  await mkdir(cacheDir, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  const hash = createHash("sha256");
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(partial));
    const actual = hash.digest("hex");
    if (actual !== war.sha256) {
      throw new StructurizrError(`${war.url} has checksum ${actual}, expected ${war.sha256}`);
    }
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
  return path;
}

async function tryRun(run: Run, command: string, args: string[]): Promise<{ code: number; output: string }> {
  try {
    return await run(command, args);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new StructurizrError(
      command === "docker"
        ? "docker was not found; install Docker, or set structurizr.runner to java in .bearing/config.yaml"
        : "java was not found; install Java 21 or later, or set structurizr.runner to docker in .bearing/config.yaml",
    );
  }
}

// Structurizr stops at the first DSL error and reports it as "<message> at line <n> of <file>: <source line>".
const dslError = /StructurizrDslParserException: (.+?) at line (\d+) of (.+?): /;
const otherError = /(?:Exception|ERROR \S+ --) (.+)/;

function failure(output: string, config: Config, modelDir: string): StructurizrError {
  const dsl = dslError.exec(output);
  if (dsl) {
    const [, message = "", line = "", file = ""] = dsl;
    const host = file.startsWith(`${mountPoint}/`) ? join(modelDir, file.slice(mountPoint.length + 1)) : file;
    return new StructurizrError(message, relative(config.root, host).split(sep).join("/"), Number(line));
  }
  const other = otherError.exec(output);
  return new StructurizrError(other?.[1] ?? `Structurizr failed:\n${output.trim()}`, config.model);
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, text);
  await rename(partial, path);
}

const spawnRun: Run = (command, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") }));
  });
