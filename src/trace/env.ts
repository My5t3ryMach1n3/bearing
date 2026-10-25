import { relative, sep } from "node:path";
import { componentOf, declarationFile, testFile, type ComponentPath } from "../paths.js";
import type { TracedFile } from "./transform.js";

// `bearing test` hands the hook everything it needs in one environment variable, so the test processes never load
// the config or the model.
export const traceEnv = "BEARING_TRACE";

export interface TraceSettings {
  // The repo root, absolute.
  root: string;
  // Where span files go, absolute.
  dir: string;
  // The criterion tag template, e.g. "#<issue>/AC<n>".
  tag: string;
  components: ComponentPath[];
}

export function readTraceSettings(env = process.env): TraceSettings | undefined {
  const value = env[traceEnv];
  return value === undefined || value === "" ? undefined : (JSON.parse(value) as TraceSettings);
}

// The component an absolute path belongs to, if it's source the hook should trace: under a component path, and not
// a test, a declaration file or a package.
export function tracedFile(path: string, settings: TraceSettings): TracedFile | undefined {
  const file = relative(settings.root, path).split(sep).join("/");
  if (file.startsWith("../") || file.split("/").includes("node_modules")) return undefined;
  if (testFile.test(file) || declarationFile.test(file)) return undefined;
  const component = componentOf(file, settings.components);
  return component === undefined ? undefined : { component, file };
}
