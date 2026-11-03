import type { Language, LanguageConfig } from "../config.js";
import type { ComponentPath } from "../paths.js";
import type { TraceSettings } from "../trace/env.js";

// What Bearing needs from a language. Each language in `languages:` is read by its adapter; the rest of Bearing only
// sees what the adapters return, so the checks work the same for every language. See docs/language-adapters.md.
export interface LanguageAdapter {
  name: Language;
  // The files this language's code is in, by repo-relative path, e.g. /\.[cm]?[jt]sx?$/. Tests and declaration files
  // may match; `testFile` and `declarationFile` in paths.ts leave them out.
  sourceFile: RegExp;
  // Reads the code under one entry of `languages:` without running it: which component owns each source file, and
  // each import of one component's code from another's.
  extractImports(root: string, language: LanguageConfig, components: ComponentPath[]): ExtractedImports;
  // How `bearing test` traces this language's tests.
  traceHook: TraceHook;
  // Where a test carries its criterion tag.
  tagCarrier: TagCarrier;
}

// What one language's code gives. Paths are repo-relative with forward slashes, in any order: Bearing merges and
// sorts every language's result.
export interface ExtractedImports {
  // Every source file under the language's root that isn't a test or declaration file, owned by a component or not.
  files: string[];
  // One per import that crosses from one component's file into another component's code.
  imports: Array<{
    file: string;
    // 1-based.
    line: number;
    // The module as written, e.g. "../basket-repository/index.js".
    module: string;
    // The component owning the code the import uses. Imports within a component, of packages or of code outside the
    // repo are left out.
    destination: string;
  }>;
}

export interface TraceHook {
  // The environment the test command runs with so every process it starts in this language writes a span to
  // `settings.dir` for each call into a component's code, and a test record for each test that ends. `env` is the
  // environment so far, with other languages' hooks already added; return it with this one's added.
  env(env: NodeJS.ProcessEnv, settings: TraceSettings, options: TraceHookOptions): NodeJS.ProcessEnv;
  // The functions in a source file the hook records spans for, as spans name them. The surplus check flags those no
  // tagged test called, so list only what the hook can see called.
  tracedFunctions(code: string, file: string): string[];
}

export interface TraceHookOptions {
  // Replaces the hook's own preload, so tests can run a build of it.
  hook?: URL;
}

export interface TagCarrier {
  // Where a test writes its criterion tag, to finish "add an integration test with #2/AC1 …", e.g. "in its name".
  // The trace hook reads the tag from the same place.
  where: string;
}

// An adapter can't read the code, e.g. its project file is missing or broken.
export class DeriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeriveError";
  }
}

// An adapter can't trace the tests, e.g. the runtime is too old for its hook.
export class TraceHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceHookError";
  }
}
