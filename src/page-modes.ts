import type { PageData, PageLevel } from "./page-data.js";

// What each of the page's modes draws on a level, over the one layout `PageLevel` gives for all of them. Free of Node
// imports, so the page's script can use it as well as the tests.
//
// - Change: both sides of the PR, with what it adds, removes and changes marked.
// - Before and After: the target on each side of the PR.
// - Drift: the target after the PR, with the relationships the code makes that it doesn't declare.
//
// A PR that doesn't change the target has two modes: Target, the same as After, and Drift.

export type Mode = "change" | "before" | "after" | "target" | "drift";

export function modesOf(data: Pick<PageData, "changed">): Mode[] {
  return data.changed ? ["change", "before", "after", "drift"] : ["target", "drift"];
}

export interface Shown {
  nodes: Set<string>;
  // IDs of the level's edges and drift edges.
  edges: Set<string>;
}

export function shown(data: Pick<PageData, "elements">, level: PageLevel, mode: Mode): Shown {
  const inMode = (item: { inBefore: boolean; inAfter: boolean }) =>
    mode === "change" ? true : mode === "before" ? item.inBefore : item.inAfter;
  const nodes = new Set(level.nodes.filter((id) => data.elements[id] !== undefined && inMode(data.elements[id])));
  const edges = new Set(level.edges.filter(inMode).map((edge) => edge.id));
  if (mode === "drift") {
    for (const edge of level.drift) {
      edges.add(edge.id);
      nodes.add(edge.source).add(edge.destination);
    }
  }
  return { nodes, edges };
}
