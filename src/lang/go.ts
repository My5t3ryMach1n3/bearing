import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageConfig } from "../config.js";
import { componentOf, testFile } from "../paths.js";
import { defaultCacheDir } from "../structurizr.js";
import { traceEnv } from "../trace/env.js";
import { DeriveError, TraceHookError, type ExtractedImports, type LanguageAdapter } from "./adapter.js";

// Go: imports from `go list`, tracing by rewriting the code into a build overlay, and tags in subtest names. See
// docs/adrs/0001-trace-go-with-an-overlay.md for why the trace hook works the way it does.
//
// The parts that need Go's own parser live in Bearing's `go/` folder as a small command, bearing-go, which Bearing
// builds with the repo's go command the first time it's needed. The trace hook's runtime is `go/bearingtrace`.

// The oldest Go the trace hook works with: it reads each goroutine's parent's ID, which Go 1.21 added.
const minimumGo = [1, 21] as const;

// Bearing's Go source, in the package and in the repo alike.
const goSource = fileURLToPath(new URL("../../go/", import.meta.url));

export const go: LanguageAdapter = {
  name: "go",
  sourceFile: /\.go$/,

  // Lists the module's packages with `go list -deps`, and keeps each import of a package in another component.
  // An import names a package, so it counts towards the component holding the package's folder. Packages outside
  // the repo, vendored ones and the standard library are ignored. Only files in the current build context count, as
  // the go command sees them: a file for another OS isn't read.
  extractImports(repoRoot, language, components) {
    const root = resolve(repoRoot);
    const repoPath = (file: string) => relative(root, file).split(sep).join("/");
    const inRepo = (path: string) => path !== ".." && !path.startsWith("../") && !path.split("/").includes("vendor");
    const project = posix.join(language.root, language.project);
    const module = moduleDir(root, language);
    if (!existsSync(join(root, project))) {
      throw new DeriveError(`${project} not found; check the Go project file in .bearing/config.yaml`);
    }
    let listed: { files: string[]; imports: Array<{ file: string; line: number; path: string; dir: string }> };
    try {
      listed = JSON.parse(runHelper(["imports"], { cwd: module })) as typeof listed;
    } catch (error) {
      throw new DeriveError(`${project}: ${message(error)}`);
    }
    const files = listed.files.map(repoPath).filter((file) => inRepo(file) && !testFile.test(file));
    const imports: ExtractedImports["imports"] = [];
    for (const { file: path, line, path: importPath, dir } of listed.imports) {
      const file = repoPath(path);
      const owner = inRepo(file) && !testFile.test(file) ? componentOf(file, components) : undefined;
      if (owner === undefined || dir === "") continue;
      const folder = repoPath(dir) || ".";
      if (!inRepo(folder)) continue;
      const destination = componentOf(folder, components);
      if (destination === undefined || destination === owner) continue;
      imports.push({ file, line, module: importPath, destination });
    }
    return { files, imports };
  },

  // Writes instrumented copies of each module's traced files and an overlay that swaps them in, then adds
  // `-overlay=<file>` to GOFLAGS, so every `go test` the command runs builds them. Nothing in the working tree
  // changes.
  traceHook: {
    env(env, settings, _options, languages) {
      const modules = languages.map((language) => moduleDir(settings.root, language));
      const flags = env.GOFLAGS ?? "";
      if (/(^|\s)-?-overlay[=\s]/.test(flags)) {
        throw new TraceHookError("GOFLAGS already has -overlay; Bearing's Go trace hook needs to set its own");
      }
      for (const module of modules) {
        const where = relative(settings.root, module).split(sep).join("/") || ".";
        if (!existsSync(join(module, "go.mod"))) {
          throw new TraceHookError(`no go.mod in ${where}; check the Go project file in .bearing/config.yaml`);
        }
        checkGoVersion(module, env, where);
        // The overlay can't add the runtime to vendor/modules.txt, so in vendor mode the build can't find it.
        const vendorMode = /(^|\s)-?-mod=vendor\b/.test(flags);
        const moduleMode = /(^|\s)-?-mod=(mod|readonly)\b/.test(flags);
        if (vendorMode || (existsSync(join(module, "vendor", "modules.txt")) && !moduleMode)) {
          throw new TraceHookError(
            `can't trace ${where}: the trace hook doesn't support vendored dependencies yet; run with GOFLAGS=-mod=mod`,
          );
        }
      }
      const input = {
        root: settings.root,
        components: settings.components,
        modules,
        runtime: join(goSource, "bearingtrace"),
        out: join(settings.dir, "go"),
      };
      let overlay: string;
      try {
        ({ overlay } = JSON.parse(runHelper(["overlay"], { env, input: JSON.stringify(input) })) as {
          overlay: string;
        });
      } catch (error) {
        throw new TraceHookError(`couldn't instrument the Go code: ${message(error)}`);
      }
      // GOFLAGS is split at spaces, with no way to quote one.
      if (/\s/.test(overlay)) {
        const copy = join(mkdtempSync(join(tmpdir(), "bearing-go-")), "overlay.json");
        if (/\s/.test(copy)) {
          throw new TraceHookError(`can't pass the Go overlay to GOFLAGS: its path has a space in it (${copy})`);
        }
        copyFileSync(overlay, copy);
        overlay = copy;
      }
      return {
        ...env,
        GOFLAGS: [flags, `-overlay=${overlay}`].filter(Boolean).join(" "),
        [traceEnv]: JSON.stringify(settings),
        // Read while each test runs, so the go command never replays a cached result instead of tracing the test.
        BEARING_GO_TRACE_RUN: randomBytes(8).toString("hex"),
      };
    },
    // The go command builds packages that -cover or -coverpkg covers from the files on disk, not the overlay, so
    // their calls go untraced. The runtime notes when a test binary collected coverage.
    warnings(settings) {
      const covered =
        existsSync(settings.dir) && readdirSync(settings.dir).some((name) => name.startsWith("go-cover-"));
      return covered
        ? [
            "Go tests ran with coverage on, and the go command builds the packages it covers without the trace hook, so their calls are missing from the traces; run `bearing test` without -cover or -coverpkg",
          ]
        : [];
    },
    // Exported functions, and exported methods of exported types as "Type.Method": what the rewriter wraps.
    tracedFunctions(code) {
      try {
        return JSON.parse(runHelper(["functions"], { input: code })) as string[];
      } catch (error) {
        throw new DeriveError(`couldn't read Go functions: ${message(error)}`);
      }
    },
  },

  // The runtime finds the tag in the test's full name, `TestReminders/#3/AC1_sends_…`. Go writes spaces in subtest
  // names as underscores; a space in the tag template matches either.
  tagCarrier: { where: "in its subtest name" },
};

// The folder holding the language's go.mod, absolute.
function moduleDir(root: string, language: LanguageConfig): string {
  return dirname(resolve(root, language.root, language.project));
}

function checkGoVersion(module: string, env: NodeJS.ProcessEnv, where: string) {
  let version: string;
  try {
    version = execFileSync("go", ["env", "GOVERSION"], { cwd: module, env, encoding: "utf8", stdio: "pipe" }).trim();
  } catch (error) {
    throw new TraceHookError(`couldn't run go in ${where}: ${message(error)}`);
  }
  const [, major, minor] = /^go(\d+)\.(\d+)/.exec(version) ?? [];
  if (major === undefined || minor === undefined) return; // A development build.
  const [wantMajor, wantMinor] = minimumGo;
  if (Number(major) < wantMajor || (Number(major) === wantMajor && Number(minor) < wantMinor)) {
    throw new TraceHookError(`tracing Go needs Go ${wantMajor}.${wantMinor} or later; ${where} builds with ${version}`);
  }
}

interface HelperOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

// Runs bearing-go, building it first if this version of it isn't in the cache, and returns what it prints.
function runHelper(args: string[], options: HelperOptions = {}): string {
  return execFileSync(helper(), args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 256 * 1024 * 1024,
  });
}

let built: string | undefined;

// bearing-go's path in Bearing's cache, named by a hash of its source so an upgrade builds it afresh.
function helper(): string {
  if (built !== undefined) return built;
  const hash = createHash("sha256");
  for (const file of sourceFiles(goSource)) {
    hash.update(relative(goSource, file).split(sep).join("/")).update("\0").update(readFileSync(file)).update("\0");
  }
  const exe = process.platform === "win32" ? ".exe" : "";
  const dir = join(defaultCacheDir(), "go");
  const path = join(dir, `bearing-go-${hash.digest("hex").slice(0, 16)}${exe}`);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const partial = `${path}.${process.pid}${exe}`;
    try {
      execFileSync("go", ["build", "-trimpath", "-o", partial, "./cmd/bearing-go"], {
        cwd: goSource,
        // Built on its own, whatever the repo's settings.
        env: { ...process.env, GOFLAGS: "", GOWORK: "off", CGO_ENABLED: "0" },
        stdio: "pipe",
      });
      renameSync(partial, path);
    } catch (error) {
      rmSync(partial, { force: true });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("go not found; install Go and put it on PATH to read Go code", { cause: error });
      }
      throw new Error(`couldn't build Bearing's Go helper: ${message(error)}`, { cause: error });
    }
  }
  built = path;
  return path;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(go|s|mod)$/.test(entry.name) ? [path] : [];
    });
}

// What a failed command said, or the error's own message.
function message(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  if (text.trim() !== "") return text.trim();
  return error instanceof Error ? error.message : String(error);
}
