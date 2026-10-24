import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Ajv, type ErrorObject, type JSONSchemaType } from "ajv";
import { isMap, isScalar, LineCounter, parseDocument, type Document } from "yaml";

export const configPath = join(".bearing", "config.yaml");

export type Language = "typescript";
export type CheckMode = "advisory" | "off";

// `.bearing/config.yaml` as written. See the Config section of docs/product-spec.md.
interface ConfigFile {
  version: 1;
  model: string;
  structurizr: { runner: "docker" | "java" };
  language: Language;
  tsconfig: string;
  requirements: { source: "github-issues"; label: string };
  tests: { integration?: string; tag: string };
  iac: { terraform?: string };
  agent: { selfHealAttempts: number };
  checks: { surplus: CheckMode; responsibilities: CheckMode };
}

// The loaded config every command works from. Paths are relative to `root`.
export interface Config extends Omit<ConfigFile, "language"> {
  // The repo root: the directory holding `.bearing/`.
  root: string;
  // A list so M2 can accept `languages:` without changing callers; only TypeScript for now.
  languages: Language[];
}

// Ajv inserts this for a missing section, then fills the section's own defaults.
const emptyObject = {} as never;

const checkMode = { type: "string", enum: ["advisory", "off"], default: "advisory" } as const;

export const configSchema: JSONSchemaType<ConfigFile> = {
  type: "object",
  additionalProperties: false,
  required: ["version", "model", "language"],
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
    language: { type: "string", enum: ["typescript"] },
    tsconfig: { type: "string", minLength: 1, default: "tsconfig.json" },
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
      properties: { terraform: { type: "string", minLength: 1, nullable: true } },
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
  if (!validate(data)) {
    const problems = (validate.errors ?? []).map((error) => describe(error, doc, lineCounter));
    throw new ConfigError(file, [...new Set(problems)]);
  }
  const { language, ...rest } = data;
  return { ...rest, root, languages: [language] };
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
  return isScalar(node) || isMap(node) ? node.range?.[0] : undefined;
}

function keyOffset(doc: Document, path: string[]): number | undefined {
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) return undefined;
  const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === path.at(-1));
  return isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
}
