import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { componentOf, testFile } from "../paths.js";
import { traceEnv } from "../trace/env.js";
import { DeriveError, TraceHookError, type ExtractedImports, type LanguageAdapter } from "./adapter.js";

// Python: imports read with Python's own parser, tracing through a pytest plugin that rewrites each component
// module as it's imported, and tags in a `req` marker.
//
// The Python code lives in Bearing's `python/` folder as the package bearing_python, which needs only the standard
// library. Bearing runs its `cli.py` with the interpreter BEARING_PYTHON names, or python3, to read code; the test
// command's own interpreter loads the plugin.

// Bearing's Python source, in the package and in the repo alike.
const pythonSource = fileURLToPath(new URL("../../python/", import.meta.url));

// Loaded by pytest from PYTEST_PLUGINS.
const plugin = "bearing_python.pytest_plugin";

export const python: LanguageAdapter = {
  name: "python",
  sourceFile: /\.py$/,

  // Lists every .py file under the language's root and resolves each import with Python's `ast`. Absolute imports
  // resolve against the source roots pyproject.toml declares, relative ones against the importing file's package.
  // An import counts towards the component declaring what it uses: `from app.booking import BookingService` through
  // a package `__init__.py` that re-exports it from `app/booking/service.py` counts towards that file's component.
  // Packages, the standard library and code outside the repo are ignored.
  extractImports(repoRoot, language, components) {
    const root = resolve(repoRoot);
    const repoPath = (file: string) => relative(root, file).split(sep).join("/");
    const inRepo = (path: string) => path !== ".." && !path.startsWith("../");
    const project = posix.join(language.root, language.project);
    if (!existsSync(join(root, project))) {
      throw new DeriveError(`${project} not found; check the Python project file in .bearing/config.yaml`);
    }
    let listed: { files: string[]; imports: Array<{ file: string; line: number; module: string; targets: string[] }> };
    try {
      const input = { root: resolve(root, language.root), project: resolve(root, project) };
      listed = JSON.parse(runHelper(["imports"], JSON.stringify(input))) as typeof listed;
    } catch (error) {
      throw new DeriveError(`${project}: ${message(error)}`);
    }
    const files = listed.files.map(repoPath).filter((file) => inRepo(file) && !testFile.test(file));
    const imports: ExtractedImports["imports"] = [];
    for (const { file: path, line, module, targets } of listed.imports) {
      const file = repoPath(path);
      const owner = inRepo(file) && !testFile.test(file) ? componentOf(file, components) : undefined;
      if (owner === undefined) continue;
      const destinations = new Set<string>();
      for (const target of targets) {
        const declared = repoPath(target);
        if (!inRepo(declared)) continue;
        const destination = componentOf(declared, components);
        if (destination !== undefined && destination !== owner) destinations.add(destination);
      }
      for (const destination of destinations) imports.push({ file, line, module, destination });
    }
    return { files, imports };
  },

  // Puts bearing_python on PYTHONPATH and its plugin in PYTEST_PLUGINS, so every pytest the command runs loads it
  // before any test or conftest. The plugin adds an import hook that compiles each component module from source with
  // a trace decorator on every public function and method, and writes no bytecode. Nothing in the working tree
  // changes.
  traceHook: {
    env(env, settings) {
      const plugins = (env.PYTEST_PLUGINS ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      if (plugins.includes(plugin)) {
        throw new TraceHookError(`PYTEST_PLUGINS already loads ${plugin}; leave it to bearing test`);
      }
      const source = pythonSource.replace(/[\\/]$/, "");
      return {
        ...env,
        PYTHONPATH: [source, env.PYTHONPATH].filter(Boolean).join(delimiter),
        PYTEST_PLUGINS: [...plugins, plugin].join(","),
        [traceEnv]: JSON.stringify(settings),
      };
    },
    // Public module-level functions, and public methods of public module-level classes as "Class.method": what the
    // plugin wraps.
    tracedFunctions(code) {
      try {
        return JSON.parse(runHelper(["functions"], code)) as string[];
      } catch (error) {
        throw new DeriveError(`couldn't read Python functions: ${message(error)}`);
      }
    },
  },

  // The plugin reads the tag from the test's closest `req` marker, on the test, its class or its module.
  tagCarrier: { where: "in a @pytest.mark.req marker" },
};

// The interpreter Bearing reads Python code with.
function interpreter(): string {
  return process.env.BEARING_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

// Runs bearing_python's cli.py and returns what it prints. -I keeps the repo's own files and PYTHONPATH from
// shadowing the standard library.
function runHelper(args: string[], input: string): string {
  const python = interpreter();
  try {
    return execFileSync(python, ["-I", join(pythonSource, "bearing_python", "cli.py"), ...args], {
      input,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${python} not found; install Python, or set BEARING_PYTHON, to read Python code`, {
        cause: error,
      });
    }
    throw error;
  }
}

// What a failed command said, or the error's own message.
function message(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  if (text.trim() !== "") return text.trim();
  return error instanceof Error ? error.message : String(error);
}
