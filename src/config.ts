import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Ajv, type ErrorObject, type JSONSchemaType } from "ajv";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from "yaml";
import { normalizePath } from "./paths.js";

export const configPath = join(".bearing", "config.yaml");

export const languageNames = ["typescript", "go", "python"] as const;
export type Language = (typeof languageNames)[number];
export type CheckMode = "advisory" | "off";

// The project file each language reads when `project` isn't given, relative to the language's root.
const defaultProject: Record<Language, string> = {
  typescript: "tsconfig.json",
  go: "go.mod",
  python: "pyproject.toml",
};

// One entry of `languages:`, or the single language `language:` names.
export interface LanguageConfig {
  name: Language;
  // The folder holding the language's code and project file, relative to the repo root and normalized; "." for the
  // repo root.
  root: string;
  // The project file, e.g. tsconfig.json, relative to `root`.
  project: string;
}

// `.bearing/config.yaml` as written. See the Config section of docs/product-spec.md.
interface ConfigFile {
  version: 1;
  model: string;
  structurizr: { runner: "docker" | "java" };
  // Either `language` (with `tsconfig`) for a repo in one language, or `languages`.
  language?: Language;
  tsconfig?: string;
  languages?: Array<{ name: Language; root: string; project?: string }>;
  requirements: { source: "github-issues"; label: string };
  tests: { integration?: string; tag: string };
  iac: { terraform?: string; kubernetes?: string };
  agent: { selfHealAttempts: number };
  checks: { surplus: CheckMode; responsibilities: CheckMode };
}

// The loaded config every command works from. Paths are relative to `root`.
export interface Config extends Omit<ConfigFile, "language" | "tsconfig" | "languages"> {
  // The repo root: the directory holding `.bearing/`.
  root: string;
  // Every language in the repo, with `language:` read as a one-entry list at the repo root.
  languages: LanguageConfig[];
}

// Ajv inserts this for a missing section, then fills the section's own defaults.
const emptyObject = {} as never;

const checkMode = { type: "string", enum: ["advisory", "off"], default: "advisory" } as const;

export const configSchema: JSONSchemaType<ConfigFile> = {
  type: "object",
  additionalProperties: false,
  required: ["version", "model"],
  properties: {
    version: { type: "number", const: 1 },
    model: { type: "string", minLength: 1 },
    structurizr: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { runner: { type: "string", enum: ["docker", "java"], default: "docker" } },
      default: emptyObject,
    },
    language: { type: "string", enum: languageNames, nullable: true },
    tsconfig: { type: "string", minLength: 1, nullable: true },
    languages: {
      type: "array",
      minItems: 1,
      nullable: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", enum: languageNames },
          root: { type: "string", minLength: 1, default: "." },
          project: { type: "string", minLength: 1, nullable: true },
        },
      },
    },
    requirements: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        source: { type: "string", const: "github-issues", default: "github-issues" },
        label: { type: "string", minLength: 1, default: "requirement" },
      },
      default: emptyObject,
    },
    tests: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        integration: { type: "string", minLength: 1, nullable: true },
        // Both placeholders are needed to tie a test to one acceptance criterion.
        tag: { type: "string", pattern: "^(?=.*<issue>)(?=.*<n>)", default: "#<issue>/AC<n>" },
      },
      default: emptyObject,
    },
    iac: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        terraform: { type: "string", minLength: 1, nullable: true },
        kubernetes: { type: "string", minLength: 1, nullable: true },
      },
      default: emptyObject,
    },
    agent: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { selfHealAttempts: { type: "integer", minimum: 1, default: 3 } },
      default: emptyObject,
    },
    checks: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { surplus: checkMode, responsibilities: checkMode },
      default: emptyObject,
    },
  },
};

const validate = new Ajv({ allErrors: true, useDefaults: true }).compile(configSchema);

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`${file}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

// Walks up from `from` to the nearest directory holding `.bearing/config.yaml`.
export function findConfigRoot(from = process.cwd()): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, configPath))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

export function loadConfig(from = process.cwd()): Config {
  const root = findConfigRoot(from);
  if (root === undefined) {
    throw new ConfigError(configPath, [`not found in ${from} or any parent directory; run \`bearing init\``]);
  }
  const file = join(root, configPath);
  return parseConfig(readFileSync(file, "utf8"), root, relative(from, file) || configPath);
}

// Parses and validates config text. `file` only labels error messages.
export function parseConfig(text: string, root: string, file = configPath): Config {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  if (doc.errors.length > 0) {
    throw new ConfigError(
      file,
      doc.errors.map((error) => `line ${lineCounter.linePos(error.pos[0]).line}: ${error.message.split("\n")[0]}`),
    );
  }
  const data: unknown = doc.toJS() ?? {};
  // Neither is required by the schema, since either will do.
  const noLanguage =
    typeof data === "object" && data !== null && !("language" in data) && !("languages" in data)
      ? ['missing required key "language" or "languages"']
      : [];
  if (!validate(data)) {
    const problems = (validate.errors ?? []).map((error) => describe(error, doc, lineCounter));
    throw new ConfigError(file, [...new Set([...problems, ...noLanguage])]);
  }
  const { language, tsconfig, languages, ...rest } = data;
  const problems: string[] = [...noLanguage];
  const at = (path: string[]) => {
    const offset = keyOffset(doc, path) ?? valueOffset(doc, path);
    return offset === undefined ? "" : `line ${lineCounter.linePos(offset).line}: `;
  };
  if (language !== undefined && languages !== undefined) {
    problems.push(
      `${at(["languages"])}"language" and "languages" can't both be set; list every language under "languages"`,
    );
  }
  if (rest.iac.terraform !== undefined && rest.iac.kubernetes !== undefined) {
    problems.push(
      `${at(["iac", "kubernetes"])}"iac.terraform" and "iac.kubernetes" can't both be set yet; Bearing compares one with the deployment view`,
    );
  }
  if (tsconfig !== undefined && language === undefined) {
    problems.push(
      `${at(["tsconfig"])}"tsconfig" only goes with "language"; under "languages", set each one's "project"`,
    );
  }
  const list: LanguageConfig[] =
    languages === undefined
      ? language === undefined
        ? []
        : [{ name: language, root: ".", project: tsconfig ?? defaultProject[language] }]
      : languages.map(({ name, root: folder, project }) => ({
          name,
          root: normalizePath(folder) || ".",
          project: project ?? defaultProject[name],
        }));
  const seen = new Set<string>();
  list.forEach(({ name, root: folder }, index) => {
    const key = `${name} ${folder}`;
    if (seen.has(key)) problems.push(`${at(["languages", String(index)])}${name} is listed twice at root "${folder}"`);
    seen.add(key);
    if (folder === ".." || folder.startsWith("../") || isAbsolute(folder)) {
      problems.push(`${at(["languages", String(index), "root"])}"languages.${index}.root" must be inside the repo`);
    }
  });
  if (problems.length > 0) throw new ConfigError(file, problems);
  return { ...rest, root, languages: list };
}

function describe(error: ErrorObject, doc: Document, lineCounter: LineCounter): string {
  const path = error.instancePath.split("/").slice(1);
  let message: string;
  let at: number | undefined;
  if (error.keyword === "additionalProperties") {
    const key = String(error.params.additionalProperty);
    path.push(key);
    message = `unknown key "${path.join(".")}"`;
    at = keyOffset(doc, path);
  } else if (error.keyword === "required") {
    path.push(String(error.params.missingProperty));
    message = `missing required key "${path.join(".")}"`;
  } else {
    message = `"${path.join(".") || "(root)"}" ${explain(error)}`;
    at = valueOffset(doc, path);
  }
  return at === undefined ? message : `line ${lineCounter.linePos(at).line}: ${message}`;
}

function explain(error: ErrorObject): string {
  switch (error.keyword) {
    case "enum":
      return `must be one of: ${(error.params.allowedValues as unknown[]).join(", ")}`;
    case "const":
      return `must be ${String(error.params.allowedValue)}`;
    case "pattern":
      return "must contain both <issue> and <n>";
    case "minLength":
      return "must not be empty";
    default:
      return error.message ?? "is invalid";
  }
}

function valueOffset(doc: Document, path: string[]): number | undefined {
  const node = doc.getIn(path, true);
  return isScalar(node) || isMap(node) || isSeq(node) ? node.range?.[0] : undefined;
}

function keyOffset(doc: Document, path: string[]): number | undefined {
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) return undefined;
  const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === path.at(-1));
  return isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
}
