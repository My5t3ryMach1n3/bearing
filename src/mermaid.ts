import type { DynamicStep } from "./model.js";

// Drawing Bearing's PR comment diagrams in Mermaid, which GitHub renders natively: flowcharts with subgraphs, not
// Mermaid's C4 diagram types, which GitHub renders as experimental, and sequence diagrams for dynamic views.

// Added and removed are the PR's changes to the target, and changed one of its fields. Drifted is code that doesn't do
// what the target says.
export type Mark = "added" | "removed" | "changed" | "drifted";

export interface Overlay {
  nodes: OverlayNode[];
  edges: OverlayEdge[];
}

export interface OverlayNode {
  // Stable ID of the element or deployment element; a Terraform resource's address for a node only it has.
  id: string;
  name: string;
  // What it is, e.g. "Component" or "Deployment node", and its technology.
  kind: string;
  // The name of the box it's drawn in: its container or software system, or its deployment environment.
  group?: string;
  mark?: Mark;
}

export interface OverlayEdge {
  source: string;
  destination: string;
  label: string;
  mark?: Mark;
}

const colours: Record<Mark, { node: string; link: string }> = {
  added: { node: "fill:#dafbe1,stroke:#1a7f37,color:#1f2328", link: "stroke:#1a7f37,stroke-width:2px" },
  removed: {
    node: "fill:#f6f8fa,stroke:#8c959f,stroke-dasharray:4 3,color:#59636e",
    link: "stroke:#8c959f,stroke-width:2px",
  },
  changed: { node: "fill:#fff8c5,stroke:#9a6700,color:#1f2328", link: "stroke:#9a6700,stroke-width:2px" },
  drifted: { node: "fill:#ffebe9,stroke:#cf222e,color:#1f2328", link: "stroke:#cf222e,stroke-width:2px" },
};

// The overlay as a Mermaid flowchart, each element in a box for its container or environment.
export function formatMermaid(overlay: Overlay): string {
  const ids = new Map(overlay.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ["flowchart LR"];
  const groups = new Map<string | undefined, OverlayNode[]>();
  for (const node of overlay.nodes) groups.set(node.group, [...(groups.get(node.group) ?? []), node]);
  const label = (node: OverlayNode) =>
    `${ids.get(node.id)}["${escape(node.name)}${node.kind === "" ? "" : `<br/>[${escape(node.kind)}]`}"]`;
  let group = 0;
  for (const [name, members] of groups) {
    if (name === undefined) {
      for (const node of members) lines.push(`  ${label(node)}`);
      continue;
    }
    lines.push(`  subgraph g${group++}["${escape(name)}"]`);
    for (const node of members) lines.push(`    ${label(node)}`);
    lines.push("  end");
  }
  overlay.edges.forEach((edge) => {
    const arrow = edge.mark === "removed" ? "-.->" : "-->";
    const text = edge.label === "" ? "" : `|"${escape(edge.label)}"|`;
    lines.push(`  ${ids.get(edge.source)} ${arrow}${text} ${ids.get(edge.destination)}`);
  });
  for (const mark of ["added", "removed", "changed", "drifted"] as const) {
    const marked = overlay.nodes.filter((node) => node.mark === mark).map((node) => ids.get(node.id));
    const links = overlay.edges.flatMap((edge, index) => (edge.mark === mark ? [index] : []));
    if (marked.length > 0)
      lines.push(`  classDef ${mark} ${colours[mark].node}`, `  class ${marked.join(",")} ${mark}`);
    if (links.length > 0) lines.push(`  linkStyle ${links.join(",")} ${colours[mark].link}`);
  }
  return lines.join("\n");
}

// A dynamic view's steps as a Mermaid sequence diagram, numbered, with each participant named by `nameOf`.
export function formatSequence(steps: DynamicStep[], nameOf: (id: string) => string): string {
  const participants = [...new Set(steps.flatMap((step) => [step.source, step.destination]))];
  const ids = new Map(participants.map((id, index) => [id, `p${index}`]));
  return [
    "sequenceDiagram",
    "  autonumber",
    ...participants.map((id) => `  participant ${ids.get(id)} as ${escapeLine(nameOf(id))}`),
    ...steps.map(
      (step) => `  ${ids.get(step.source)}->>${ids.get(step.destination)}: ${escapeLine(step.description) || " "}`,
    ),
  ].join("\n");
}

// Mermaid reads quotes, angle brackets and the like in a label as syntax, so they go in as its entity codes.
function escape(text: string): string {
  return text.replace(/["<>#|]/g, (char) => `#${char.charCodeAt(0)};`);
}

// A sequence diagram also ends a line at a semicolon or a newline.
function escapeLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/["<>#|;]/g, (char) => `#${char.charCodeAt(0)};`);
}
