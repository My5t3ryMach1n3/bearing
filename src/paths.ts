import { posix } from "node:path";
import type { Model } from "./model.js";

// Path helpers shared by the extractors and the trace hook. The hook runs inside the test processes, so this module
// stays free of heavy imports.

export function normalizePath(path: string): string {
  const trimmed = path.trim().replaceAll("\\", "/");
  return trimmed === "" ? "" : posix.normalize(trimmed).replace(/(.)\/$/, "$1");
}

export function within(path: string, folder: string): boolean {
  return folder === "." || path === folder || path.startsWith(`${folder}/`);
}

// Tests exercise components rather than belong to them, so they make no relationships, are never surplus and are
// never traced.
export const testFile = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export const declarationFile = /\.d\.[cm]?ts$/;

export interface ComponentPath {
  id: string;
  // Repo-relative folder, normalized.
  path: string;
}

// The target's components that own a folder. Longest path first, so the most specific folder wins if
// `bearing validate` hasn't caught an overlap yet.
export function componentPaths(target: Model): ComponentPath[] {
  return [...target.elements.values()]
    .filter((element) => element.type === "component" && element.path !== undefined)
    .map((component) => ({ id: component.id, path: normalizePath(component.path!) }))
    .filter((component) => component.path !== "")
    .sort((a, b) => b.path.length - a.path.length);
}

// The component owning a repo-relative file, from a list sorted by `componentPaths`.
export function componentOf(file: string, components: ComponentPath[]): string | undefined {
  return components.find((component) => within(file, component.path))?.id;
}
