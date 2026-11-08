/// <reference lib="dom" />
import type { FileChange } from "./code-changes.js";
import type { FieldChange } from "./diff.js";
import type { Mark, PageData, PageEdge, PageLevel, PageStep, PageView, TabId } from "./page-data.js";
import type { LevelLayout, Point, Rect } from "./page-layout.js";
import { shown, type Mode } from "./page-modes.js";

// The architecture page's script: draws the page from the data `bearing page` embeds, as the style guide from #117
// sets it out (spikes/architecture-page/style/README.md). Compiled with the rest of Bearing and inlined into the page,
// with page-modes.ts inlined before it, so the file loads nothing from outside. See #116 and #120.
//
// The model's text is the PR author's to write, so it reaches the page only through `textContent` and
// `setAttribute`, never as markup.

// What `bearing page` embeds, as JSON, in the page's `#bearing-page` script element.
export interface PagePayload {
  data: PageData;
  layouts: Record<string, LevelLayout>;
  // The PR's title, e.g. "Share a basket by email".
  title: string;
  // Which PR and commit it's for, e.g. "#42 share-a-basket @ 3f9c2e1".
  ref: string;
}

type Side = "before" | "change" | "after";

interface State {
  tab: TabId;
  level: string;
  side: Side;
  // What's selected: `el:<id>`, `rel:<id>`, `drift:<id>`, `adr:<path>`, `file:<path>`, `step:<index>`, `off:<n>`.
  selected?: string;
  view?: string;
  // An index in the view's steps.
  step?: number;
  // The map's scale, or undefined to fit it to the width.
  zoom?: number;
}

const NS = "http://www.w3.org/2000/svg";
const payload = JSON.parse(document.getElementById("bearing-page")?.textContent ?? "{}") as PagePayload;
const data = payload.data;
const E = data.elements;
const levelsById = new Map(data.levels.map((level) => [level.id, level]));
const tabs: TabId[] = ["target", "code", "build", "behaviour"];
const tabNames: Record<TabId, string> = { target: "Target", code: "Code", build: "Build", behaviour: "Behaviour" };
const heatSteps: Array<[number, string]> = [
  [1, "1–9"],
  [2, "10–49"],
  [3, "50–149"],
  [4, "150+"],
];
const pad = 16;

// ---- DOM helpers: text only ever goes in through textContent.

function add<K extends keyof HTMLElementTagNameMap>(
  parent: Node,
  tag: K,
  text?: string | number,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className !== undefined && className !== "") node.className = className;
  parent.appendChild(node);
  return node;
}

function svg(name: string, attributes: Record<string, string | number | undefined>, parent?: Node): SVGElement {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined) node.setAttribute(key, String(value));
  parent?.appendChild(node);
  return node;
}

function svgText(parent: Node, value: string, attributes: Record<string, string | number | undefined>): SVGElement {
  const node = svg("text", attributes, parent);
  node.textContent = value;
  return node;
}

const byId = (id: string) => document.getElementById(id)!;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lines = (count: { added: number; removed: number } | undefined) =>
  count === undefined ? 0 : count.added + count.removed;
const signed = (count: { added: number; removed: number }) => `+${count.added} −${count.removed}`;
const heatOf = (n: number) => (n === 0 ? 0 : n < 10 ? 1 : n < 50 ? 2 : n < 150 ? 3 : 4);
// Cuts text to `max` characters, with an ellipsis.
const fit = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const nameOf = (id: string | undefined) => (id === undefined ? "the test" : (E[id]?.name ?? id));
// A view's name: its title, led by its issue unless the title already is.
const viewName = (each: PageView) =>
  each.issue === undefined || each.title.startsWith(each.issue) ? each.title : `${each.issue} ${each.title}`;
const show = (value: unknown) =>
  value === undefined ? "none" : typeof value === "string" ? value : JSON.stringify(value);

// ---- Where things are drawn.

const ancestors = (id: string): string[] => {
  const out: string[] = [];
  for (let at = E[id]?.parent; at !== undefined && !out.includes(at); at = E[at]?.parent) out.push(at);
  return out;
};
// A level's short name, as a link to it says it: its scope's name.
const levelName = (id: string) => (id === "context" ? "System context" : (E[id]?.name ?? id));
const hasLevel = (id: string) => E[id]?.level !== undefined && levelsById.has(id);

// The level an element is drawn on inside its scope: its parent's, or the first that draws it.
function elementLevel(id: string): string | undefined {
  const parent = E[id]?.parent;
  if (parent !== undefined && levelsById.get(parent)?.nodes.includes(id)) return parent;
  return data.levels.find((level) => level.nodes.includes(id))?.id;
}

// The level a relationship is drawn on between its own ends, or failing that the first it's lifted onto.
function relationshipLevel(id: string): string | undefined {
  const relationship = data.relationships[id];
  const holds = (edge: PageEdge) => edge.relationships.includes(id);
  const exact = data.levels.find((level) =>
    level.edges.some(
      (edge) => holds(edge) && edge.source === relationship?.source && edge.destination === relationship?.destination,
    ),
  );
  return (exact ?? data.levels.find((level) => level.edges.some(holds)))?.id;
}

function driftLevel(id: string): string | undefined {
  const drift = data.drift[id];
  const exact = data.levels.find((level) =>
    level.drift.some(
      (edge) => edge.drift.includes(id) && edge.source === drift?.source && edge.destination === drift?.destination,
    ),
  );
  return (exact ?? data.levels.find((level) => level.drift.some((edge) => edge.drift.includes(id))))?.id;
}

// The level a selection is drawn on, when it's drawn on one.
function levelOfSelection(key: string): string | undefined {
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  if (kind === "el") return elementLevel(id);
  if (kind === "rel") return relationshipLevel(id);
  if (kind === "drift") return driftLevel(id);
  return undefined;
}

// Whether the current level draws a selection.
function onLevel(level: PageLevel, key: string): boolean {
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  if (kind === "el") return level.nodes.includes(id) || level.scope === id;
  if (kind === "rel") return level.edges.some((edge) => edge.relationships.includes(id));
  if (kind === "drift") return level.drift.some((edge) => edge.drift.includes(id));
  return true;
}

// The level to open on: the one that draws the most of what the PR changes, adds and drifts.
function defaultLevel(): string {
  const score = new Map<string, number>();
  const count = (level: string | undefined) => {
    if (level !== undefined) score.set(level, (score.get(level) ?? 0) + 1);
  };
  for (const element of Object.values(E)) {
    if (element.mark !== undefined) count(elementLevel(element.id));
  }
  for (const relationship of Object.values(data.relationships)) {
    if (relationship.mark !== undefined) count(relationshipLevel(relationship.id));
  }
  for (const id of data.code.components) count(elementLevel(id));
  for (const id of Object.keys(data.drift)) count(driftLevel(id));
  let best = data.levels[0]?.id ?? "context";
  for (const level of data.levels) if ((score.get(level.id) ?? 0) > (score.get(best) ?? 0)) best = level.id;
  return best;
}

// ---- State, kept in the URL hash.

const state: State = { tab: "target", level: defaultLevel(), side: "change" };
const view = (): PageView | undefined => data.views.find((each) => each.id === state.view) ?? data.views[0];

function readHash(): void {
  const hash = new URLSearchParams(location.hash.slice(1));
  const tab = hash.get("tab");
  if (tab !== null && (tabs as string[]).includes(tab)) state.tab = tab as TabId;
  const level = hash.get("level");
  if (level !== null && levelsById.has(level)) state.level = level;
  const side = hash.get("side");
  if (side === "before" || side === "after" || side === "change") state.side = side;
  const chosen = hash.get("view");
  if (chosen !== null && data.views.some((each) => each.id === chosen)) state.view = chosen;
  const step = Number(hash.get("step"));
  state.step = Number.isInteger(step) && step >= 1 && step <= (view()?.steps.length ?? 0) ? step - 1 : undefined;
  const selected = hash.get("sel");
  state.selected = selected === null || selected === "" ? undefined : selected;
}

function writeHash(): void {
  const hash = new URLSearchParams({ tab: state.tab, level: state.level });
  if (state.tab === "target" && data.changed && state.side !== "change") hash.set("side", state.side);
  if (state.tab === "behaviour" && view() !== undefined) hash.set("view", view()!.id);
  if (state.tab === "behaviour" && state.step !== undefined) hash.set("step", String(state.step + 1));
  if (state.selected !== undefined) hash.set("sel", state.selected);
  const next = `#${hash.toString()}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

function setTab(tab: TabId): void {
  if (state.tab === tab) return;
  state.tab = tab;
  state.selected = undefined;
  state.step = undefined;
  draw();
}

function goTo(level: string, selected?: string): void {
  state.level = level;
  state.selected = selected;
  draw();
}

function select(key: string): void {
  state.selected = state.selected === key ? undefined : key;
  if (key.startsWith("step:")) {
    const index = Number(key.slice(5));
    state.step = state.selected === undefined ? undefined : index;
  }
  draw();
}

// ---- The header and the tab bar.

function drawTitle(): void {
  byId("title").textContent = payload.title;
  byId("ref").textContent = payload.ref;
}

function quiet(tab: TabId): boolean {
  const result = data.tabs[tab];
  return !result.attention && ["no change", "not checked", "matches"].includes(result.counter);
}

function drawTabs(): void {
  const root = byId("tabs");
  root.replaceChildren();
  tabs.forEach((tab, index) => {
    const result = data.tabs[tab];
    const button = add(root, "button", undefined, result.attention ? "attention" : quiet(tab) ? "quiet" : "");
    button.type = "button";
    button.id = `tab-${tab}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.tab === tab));
    button.setAttribute("aria-controls", "panel");
    button.setAttribute("aria-keyshortcuts", String(index + 1));
    button.tabIndex = state.tab === tab ? 0 : -1;
    add(button, "span", tabNames[tab], "tab-name");
    add(button, "span", result.counter, "tab-result");
    button.addEventListener("click", () => setTab(tab));
  });
}

function drawCrumbs(): void {
  const root = byId("crumbs");
  root.replaceChildren();
  const level = levelsById.get(state.level);
  const trail: Array<[string, string]> = [["context", "System context"]];
  if (level?.scope !== undefined) {
    for (const id of [...ancestors(level.scope).reverse(), level.scope]) {
      if (levelsById.has(id)) trail.push([id, E[id]?.name ?? id]);
    }
  }
  trail.forEach(([id, name], index) => {
    if (index > 0) add(root, "span", "›", "sep");
    if (index === trail.length - 1) add(root, "span", name, "here").setAttribute("aria-current", "page");
    else add(root, "button", name).addEventListener("click", () => goTo(id));
  });
}

function drawControls(): void {
  const root = byId("controls");
  root.replaceChildren();
  if (state.tab === "target" && data.changed && !data.first) {
    const group = add(root, "div", undefined, "seg");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Side of the PR");
    for (const [side, label] of [
      ["before", "Before"],
      ["change", "Change"],
      ["after", "After"],
    ] as Array<[Side, string]>) {
      const button = add(group, "button", label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.side === side));
      button.addEventListener("click", () => {
        state.side = side;
        draw();
      });
    }
  }
  if (state.tab === "code" && data.code.total.files > 0) {
    const ramp = add(root, "span", undefined, "ramp");
    add(ramp, "span", "Lines changed", "label");
    for (const [step, label] of heatSteps) add(ramp, "span", label, `swatch heat-${step}`);
  }
  if (state.tab === "behaviour" && data.views.length > 0) {
    const picker = add(root, "select");
    picker.setAttribute("aria-label", "Dynamic view");
    for (const each of data.views) {
      const suffix =
        each.mark === "added"
          ? ", new"
          : each.mark === "changed"
            ? ", changed"
            : each.mark === "removed"
              ? ", removed"
              : "";
      const option = add(picker, "option", `${viewName(each)}${suffix}`);
      option.value = each.id;
      option.selected = each.id === view()?.id;
    }
    picker.addEventListener("change", () => {
      state.view = picker.value;
      state.step = undefined;
      state.selected = undefined;
      draw();
    });
  }
  const zoom = add(root, "div", undefined, "seg zoom");
  zoom.setAttribute("role", "group");
  zoom.setAttribute("aria-label", "Zoom");
  const zoomButton = (label: string, name: string, act: () => void) => {
    const button = add(zoom, "button", label);
    button.type = "button";
    button.setAttribute("aria-label", name);
    button.addEventListener("click", act);
    return button;
  };
  zoomButton("−", "Zoom out", () => setZoom(currentScale() / 1.25));
  zoomButton("fit", "Fit to width", () => setZoom(undefined)).setAttribute(
    "aria-pressed",
    String(state.zoom === undefined),
  );
  zoomButton("+", "Zoom in", () => setZoom(currentScale() * 1.25));
}

// ---- The findings panel.

interface Item {
  key: string;
  name: string;
  meta?: string;
  metaClass?: string;
  sub?: string;
  // Opens with the item: its detail.
  more?: (into: HTMLElement) => void;
  // The share of the tab's total it stands for, drawn as a bar.
  share?: number;
}

// Keys of the items the panel lists, so a box clicked on the map that isn't one of them gets a detail of its own.
let listed = new Set<string>();

function group(parent: HTMLElement, heading: string, count?: number): HTMLElement {
  const root = add(parent, "section", undefined, "group");
  const h = add(root, "h2", heading);
  if (count !== undefined) add(h, "small", String(count));
  return root;
}

function item(parent: HTMLElement, spec: Item): HTMLElement {
  listed.add(spec.key);
  const on = state.selected === spec.key;
  const root = add(parent, "div", undefined, `item${on ? " on" : ""}`);
  root.dataset.key = spec.key;
  const head = add(root, "button", undefined, "item-head");
  head.type = "button";
  head.setAttribute("aria-expanded", String(on));
  const row = add(head, "span", undefined, "item-row");
  add(row, "span", spec.name, "item-name");
  if (spec.meta !== undefined) add(row, "span", spec.meta, `item-meta ${spec.metaClass ?? ""}`);
  if (spec.sub !== undefined && spec.sub !== "") add(head, "span", spec.sub, "item-sub");
  if (spec.share !== undefined) {
    const track = add(head, "span", undefined, "bar-track");
    add(track, "span", undefined, "bar-fill").style.width = `${Math.max(1, Math.round(spec.share * 100))}%`;
  }
  head.addEventListener("click", () => select(spec.key));
  // A finding on another level says where, as a link.
  const level = levelsById.get(state.level);
  const elsewhere = levelOfSelection(spec.key);
  if (level !== undefined && elsewhere !== undefined && elsewhere !== state.level && !onLevel(level, spec.key)) {
    const link = add(root, "button", `${levelName(elsewhere)} ›`, "elsewhere");
    link.type = "button";
    link.addEventListener("click", () => goTo(elsewhere, spec.key));
  }
  if (on && spec.more !== undefined) spec.more(add(root, "div", undefined, "item-more"));
  return root;
}

function paragraph(parent: HTMLElement, text: string, className?: string): void {
  if (text.trim() !== "") add(parent, "p", text, className);
}

function list(parent: HTMLElement, rows: Array<[string, string]>): void {
  if (rows.length === 0) return;
  const ul = add(parent, "ul");
  for (const [left, right] of rows) {
    const li = add(ul, "li");
    add(li, "span", left);
    add(li, "span", right);
  }
}

function changesList(parent: HTMLElement, changes: FieldChange[] | undefined): void {
  for (const change of changes ?? []) {
    paragraph(parent, `${change.field}: ${show(change.from)} → ${show(change.to)}`, "mono");
  }
}

function filesList(parent: HTMLElement, files: FileChange[] | undefined): void {
  list(
    parent,
    (files ?? []).map((file): [string, string] => [file.path, file.binary === true ? "binary" : signed(file)]),
  );
}

// Everything about an element: what the details panel shows for a box.
function elementDetail(parent: HTMLElement, id: string): void {
  const element = E[id];
  if (element === undefined) return;
  paragraph(parent, [element.kind, element.technology].filter((part) => part !== "").join(" · "), "mono");
  paragraph(parent, element.description);
  if (element.path !== undefined) {
    paragraph(parent, `${element.path}${element.built === false ? "  no code yet" : ""}`, "mono");
  }
  if (element.requirements.length > 0) paragraph(parent, `Serves ${element.requirements.join(", ")}`, "mono");
  changesList(parent, element.changes);
  if (element.code !== undefined) {
    paragraph(parent, `${signed(element.code)} · ${plural(element.code.files, "file")}`, "mono");
  }
  filesList(parent, element.files);
  const level = levelsById.get(state.level);
  if (level !== undefined) {
    const rows: Array<[string, string]> = [];
    for (const edge of level.edges) {
      if (edge.source === id) rows.push([`→ ${nameOf(edge.destination)}`, edge.label]);
      if (edge.destination === id) rows.push([`← ${nameOf(edge.source)}`, edge.label]);
    }
    list(parent, rows);
  }
}

function checkLines(parent: HTMLElement, tab: TabId): void {
  const checks = data.tabs[tab].checks;
  if (checks.length === 0) return;
  const root = add(parent, "section", undefined, "checks");
  for (const check of checks) {
    const row = add(root, "p", undefined, `check ${check.status}`);
    add(row, "span", `${check.title}: `, "check-title");
    add(row, "span", check.summary === "" ? check.status : `${check.status}, ${check.summary}`);
  }
}

function drawPanel(): void {
  const root = byId("panel");
  root.replaceChildren();
  root.setAttribute("aria-labelledby", `tab-${state.tab}`);
  listed = new Set();
  const body = add(root, "div");
  if (state.tab === "target") targetPanel(body);
  if (state.tab === "code") codePanel(body);
  if (state.tab === "build") buildPanel(body);
  if (state.tab === "behaviour") behaviourPanel(body);
  checkLines(root, state.tab);
  // A box selected on the map that the tab doesn't list.
  if (state.selected?.startsWith("el:") && !listed.has(state.selected)) {
    const id = state.selected.slice(3);
    if (E[id] !== undefined) {
      const selected = group(root, "Selected");
      root.insertBefore(selected, body);
      item(selected, { key: state.selected, name: E[id].name, meta: E[id].kind, more: (m) => elementDetail(m, id) });
    }
  }
}

function empty(parent: HTMLElement, text: string): void {
  add(parent, "p", text, "empty");
}

const markOrder: Array<[Mark, string, string]> = [
  ["added", "Added", "+"],
  ["removed", "Removed", "−"],
  ["changed", "Changed", "~"],
];

function targetPanel(root: HTMLElement): void {
  if (!data.changed) {
    empty(root, "No change to the target.");
  } else if (data.first) {
    const g = group(root, "First design");
    const count = (type: string) => Object.values(E).filter((each) => each.type === type).length;
    paragraph(
      g,
      [
        plural(count("softwareSystem"), "software system"),
        plural(count("container"), "container"),
        plural(count("component"), "component"),
        plural(Object.keys(data.relationships).length, "relationship"),
      ].join(", "),
      "sub",
    );
  } else {
    let any = false;
    for (const [mark, heading, sign] of markOrder) {
      const elements = Object.values(E).filter((each) => each.mark === mark);
      const relationships = Object.values(data.relationships).filter((each) => each.mark === mark);
      if (elements.length + relationships.length === 0) continue;
      any = true;
      const g = group(root, heading, elements.length + relationships.length);
      for (const element of elements) {
        item(g, {
          key: `el:${element.id}`,
          name: `${sign} ${element.name}`,
          meta: element.external ? `${element.kind}, external` : element.kind,
          metaClass: mark === "removed" ? "" : "added",
          sub: [element.path, element.built === false ? "no code yet" : undefined].filter(Boolean).join("  "),
          more: (m) => elementDetail(m, element.id),
        });
      }
      for (const relationship of relationships) {
        item(g, {
          key: `rel:${relationship.id}`,
          name: `${sign} ${nameOf(relationship.source)} → ${nameOf(relationship.destination)}`,
          meta: "relationship",
          metaClass: mark === "removed" ? "" : "added",
          sub: relationship.description,
          more: (m) => {
            paragraph(m, relationship.technology, "mono");
            changesList(m, relationship.changes);
          },
        });
      }
    }
    if (!any) empty(root, "Only the dynamic views change: see Behaviour.");
  }
  if (data.target.adrs.length > 0 || data.changed) {
    const g = group(root, "ADR", data.target.adrs.length);
    if (data.target.adrs.length === 0) add(g, "p", "None: the PR changes the target without one.", "sub drift");
    for (const adr of data.target.adrs) {
      item(g, {
        key: `adr:${adr.path}`,
        name: adr.title,
        sub: adr.path,
        more: (m) => {
          paragraph(m, adr.reason, "prose");
          if (adr.decision !== "") paragraph(m, `Decision: ${adr.decision}`, "prose");
          if (adr.alternatives !== "") paragraph(m, `Alternatives considered: ${adr.alternatives}`, "prose");
        },
      });
    }
  }
  if (data.target.files.length > 0) paragraph(root, `Target files: ${data.target.files.join(", ")}`, "note");
}

function codePanel(root: HTMLElement): void {
  const { total, components, outside } = data.code;
  if (total.files === 0) {
    empty(root, "No change to functional code.");
  } else {
    const all = lines(total);
    const g = group(root, "Components", components.length);
    if (components.length === 0) add(g, "p", "None: no component's path holds a changed file.", "sub");
    for (const id of components) {
      const element = E[id];
      if (element === undefined) continue;
      item(g, {
        key: `el:${id}`,
        name: element.name,
        meta: element.code === undefined ? "" : signed(element.code),
        metaClass: "heat",
        sub: element.path ?? "",
        share: all === 0 ? 0 : lines(element.code) / all,
        more: (m) => filesList(m, element.files),
      });
    }
    if (outside.length > 0) {
      const o = group(root, "Outside the model", outside.length);
      for (const file of outside) {
        const slash = file.path.lastIndexOf("/");
        item(o, {
          key: `file:${file.path}`,
          name: file.path.slice(slash + 1),
          meta: file.binary === true ? "binary" : signed(file),
          metaClass: "drift",
          sub: slash === -1 ? "" : file.path.slice(0, slash + 1),
          share: all === 0 ? 0 : lines(file) / all,
          more: (m) =>
            paragraph(
              m,
              "No component's path holds it. Move it into a component's folder, or give it a component in the target.",
              "prose",
            ),
        });
      }
    }
  }
  const unbuilt = Object.values(E).filter((each) => each.built === false && each.inAfter);
  if (unbuilt.length > 0) {
    paragraph(root, `No code yet: ${unbuilt.map((each) => each.name).join(", ")}`, "note");
  }
}

function buildPanel(root: HTMLElement): void {
  const drift = data.build.drift.flatMap((id) => (data.drift[id] === undefined ? [] : [data.drift[id]]));
  if (drift.length === 0) {
    empty(root, "No drift: the code makes only the relationships the target declares.");
    return;
  }
  const g = group(root, "Undeclared", drift.length);
  for (const each of drift) {
    const first = each.imports[0];
    const grant = each.grants[0];
    item(g, {
      key: `drift:${each.id}`,
      name: `${nameOf(each.source)} → ${nameOf(each.destination)}`,
      meta: each.via === "imports" ? "import" : each.via === "send" ? "sends" : "receives",
      metaClass: "drift",
      sub:
        first !== undefined ? `${first.file}:${first.line}` : grant !== undefined ? `${grant.file}:${grant.line}` : "",
      more: (m) => {
        const declare = `declare ${nameOf(each.source)} → ${nameOf(each.destination)} in the target`;
        paragraph(
          m,
          each.through.length > 0
            ? `The target routes this through ${each.through.map(nameOf).join(" or ")}: go through it, or ${declare}.`
            : each.via === "imports"
              ? `Remove the import, or ${declare}.`
              : `Remove the permission, or ${declare}.`,
          "prose",
        );
        list(
          m,
          each.imports.map((site): [string, string] => [`${site.file}:${site.line}`, site.module]),
        );
        list(
          m,
          each.grants.map((g): [string, string] => [`${g.file}:${g.line}`, `${g.role} ${g.actions.join(", ")}`]),
        );
      },
    });
  }
}

function behaviourPanel(root: HTMLElement): void {
  const shownView = view();
  if (shownView === undefined) {
    empty(root, "No dynamic views.");
    return;
  }
  const trace = shownView.trace;
  const untested = new Set(trace?.untested ?? []);
  const g = group(root, viewName(shownView));
  if (shownView.mark === "removed") add(g, "p", "The PR removes this view.", "sub");
  if (trace === undefined) add(g, "p", "not traced", "sub");
  else if (trace.status === "skipped") add(g, "p", `not traced: ${trace.reason ?? "skipped"}`, "sub");
  else if (trace.tests.length === 0) add(g, "p", trace.reason ?? "no tagged test takes it", "sub drift");
  for (const test of trace?.tests ?? []) {
    const last = trace!.checked.lastIndexOf(true) + 1;
    const took =
      test.status === "unmatched"
        ? "goes off the path"
        : test.reached === 0
          ? "takes no step"
          : test.reached >= last
            ? "takes every step"
            : `stops after step ${shownView.steps[test.reached - 1]?.order ?? test.reached}`;
    add(g, "p", `${test.criterion} ${took}`, `sub${test.status === "unmatched" ? " drift" : ""}`);
  }
  const ol = add(g, "ol", undefined, "steps");
  shownView.steps.forEach((step, index) => {
    const li = add(ol, "li");
    const key = `step:${index}`;
    listed.add(key);
    const on = state.step === index;
    const button = add(li, "button", undefined, `step${on ? " on" : ""}${untested.has(index) ? " untested" : ""}`);
    button.type = "button";
    button.setAttribute("aria-pressed", String(on));
    add(button, "span", step.order, "order");
    add(button, "span", untested.has(index) ? `${step.description} · no test takes it` : step.description);
    button.title = `${nameOf(step.source)} → ${nameOf(step.destination)}`;
    button.addEventListener("click", () => select(key));
    if (on) {
      const more = add(li, "div", undefined, "item-more");
      paragraph(more, `${nameOf(step.source)} → ${nameOf(step.destination)}`, "mono");
      if (trace !== undefined && trace.checked[index] !== true) paragraph(more, "Trace paths doesn't check this step.");
      for (const test of trace?.tests ?? []) {
        if (trace!.checked[index])
          paragraph(more, `${test.criterion}: ${test.took[index] ? "takes it" : "doesn't"}`, "mono");
      }
    }
  });
  const off = (trace?.tests ?? []).flatMap((test) => test.offPath.map((call) => ({ test, call })));
  if (off.length > 0) {
    const o = group(root, "Off path", off.length);
    off.forEach(({ test, call }, index) => {
      item(o, {
        key: `off:${index}`,
        name: `${nameOf(call.source)} → ${nameOf(call.destination)}`,
        meta: call.offTarget ? "off target" : "off path",
        metaClass: "drift",
        sub: call.functions.map((name) => `${name}()`).join(", "),
        more: (m) => {
          paragraph(m, `${test.criterion}: ${test.name}`, "mono");
          if (test.file !== undefined) paragraph(m, test.file, "mono");
          paragraph(
            m,
            call.offTarget
              ? "The target relates these nowhere: declare the relationship, or change the code."
              : "The view has no such step: add it to the view, or change the code.",
            "prose",
          );
        },
      });
    });
  }
  if (shownView.criteria !== undefined && shownView.criteria.length > 0) {
    const c = group(root, "Criteria", shownView.criteria.length);
    for (const criterion of shownView.criteria) {
      const row = add(c, "div", undefined, "row");
      const top = add(row, "span", undefined, "item-row");
      add(top, "span", criterion.id, "item-name");
      add(top, "span", criterion.status, `item-meta ${criterion.status === "covered" ? "" : "drift"}`);
      add(row, "span", criterion.text, "item-sub");
    }
  }
  if (shownView.before !== undefined) {
    const b = group(root, "Before", shownView.before.length);
    const ol = add(b, "ol", undefined, "steps plain");
    for (const step of shownView.before) {
      const li = add(ol, "li", undefined, "step");
      add(li, "span", step.order, "order");
      add(li, "span", step.description);
    }
  }
  if (shownView.level !== state.level) {
    const p = add(root, "p", "This view is drawn in ", "note");
    const link = add(p, "button", levelsById.get(shownView.level)?.title ?? shownView.level, "link");
    link.type = "button";
    link.addEventListener("click", () => goTo(shownView.level));
  }
}

// ---- The map.

interface Look {
  nodes: Map<string, string>;
  edges: Map<string, string>;
  // Edges whose label is hidden.
  quietEdges: Set<string>;
  // Text at a box's top right.
  corner: Map<string, { text: string; className: string }>;
}

function modeOf(): Mode {
  if (state.tab === "target") return !data.changed ? "target" : data.first ? "after" : state.side;
  if (state.tab === "build") return "drift";
  if (state.tab === "behaviour" && view()?.inAfter === false) return "before";
  return data.changed ? "after" : "target";
}

function stepsOnEdges(level: PageLevel, shownView: PageView | undefined): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (shownView === undefined || shownView.level !== level.id) return out;
  shownView.steps.forEach((step: PageStep, index) => {
    const edge = level.edges.find((each) => each.source === step.from && each.destination === step.to);
    if (edge !== undefined) out.set(edge.id, [...(out.get(edge.id) ?? []), index]);
  });
  return out;
}

function lookOf(level: PageLevel): Look {
  const look: Look = { nodes: new Map(), edges: new Map(), quietEdges: new Set(), corner: new Map() };
  const addClass = (map: Map<string, string>, id: string, className: string) =>
    map.set(id, `${map.get(id) ?? ""} ${className}`.trim());
  const all = [...level.edges, ...level.drift];

  if (state.tab === "target" && data.changed && !data.first && state.side !== "before") {
    const ends = new Set<string>();
    for (const edge of level.edges) {
      if (edge.mark !== undefined) {
        addClass(look.edges, edge.id, edge.mark);
        ends.add(edge.source).add(edge.destination);
      } else if (state.side === "change") {
        addClass(look.edges, edge.id, "dim");
        look.quietEdges.add(edge.id);
      }
    }
    for (const id of level.nodes) {
      const element = E[id]!;
      const inside = element.inside;
      const marked = inside !== undefined && inside.added + inside.removed + inside.changed > 0;
      if (element.mark !== undefined) addClass(look.nodes, id, element.mark);
      else if (state.side === "change" && !marked && !ends.has(id)) addClass(look.nodes, id, "dim");
      if (marked) {
        const parts = [
          inside.added > 0 ? `+${inside.added}` : "",
          inside.removed > 0 ? `−${inside.removed}` : "",
          inside.changed > 0 ? `~${inside.changed}` : "",
        ].filter((part) => part !== "");
        look.corner.set(id, { text: `${parts.join(" ")} inside ›`, className: "added" });
      }
    }
  }

  if (state.tab === "code") {
    for (const edge of all) {
      addClass(look.edges, edge.id, "dim");
      look.quietEdges.add(edge.id);
    }
    for (const id of level.nodes) {
      const count = E[id]?.code;
      const heat = heatOf(lines(count));
      if (heat > 0) addClass(look.nodes, id, `heat-${heat}`);
      if (count === undefined) continue;
      look.corner.set(
        id,
        hasLevel(id)
          ? { text: `${signed(count)} inside ›`, className: "heat" }
          : { text: `${signed(count)} · ${plural(count.files, "file")}`, className: "heat" },
      );
    }
  }

  if (state.tab === "build" && level.drift.length > 0) {
    const concern = new Set<string>();
    const routes = new Set<string>();
    for (const edge of level.drift) {
      addClass(look.edges, edge.id, "drift");
      concern.add(edge.source).add(edge.destination);
      for (const id of edge.drift) {
        for (const through of data.drift[id]?.through ?? []) {
          concern.add(through);
          routes.add(`${edge.source}->${through}`).add(`${through}->${edge.destination}`);
        }
      }
    }
    for (const edge of level.edges) {
      if (!routes.has(`${edge.source}->${edge.destination}`)) {
        addClass(look.edges, edge.id, "dim");
        look.quietEdges.add(edge.id);
      }
    }
    for (const id of level.nodes) {
      if (!concern.has(id) && (E[id]?.inside?.drifted ?? 0) === 0) addClass(look.nodes, id, "dim");
    }
  }
  if (state.tab === "build") {
    for (const id of level.nodes) {
      const drifted = E[id]?.inside?.drifted ?? 0;
      if (hasLevel(id) && drifted > 0) look.corner.set(id, { text: `${drifted} inside ›`, className: "drift" });
    }
  }

  if (state.tab === "behaviour") {
    const shownView = view();
    if (shownView !== undefined) {
      const steps = stepsOnEdges(level, shownView);
      const untested = new Set(shownView.trace?.untested ?? []);
      const ends = new Set(shownView.steps.flatMap((step) => [step.from, step.to]));
      for (const edge of all) {
        const on = steps.get(edge.id);
        if (on === undefined) {
          addClass(look.edges, edge.id, "dim");
          look.quietEdges.add(edge.id);
          continue;
        }
        addClass(look.edges, edge.id, "step");
        look.quietEdges.add(edge.id);
        if (on.every((index) => untested.has(index))) addClass(look.edges, edge.id, "untested");
        if (state.step !== undefined && on.includes(state.step)) addClass(look.edges, edge.id, "current");
      }
      for (const id of level.nodes) {
        const inView =
          shownView.level === level.id ? ends.has(id) : ancestors(shownView.level).concat(shownView.level).includes(id);
        if (!inView) addClass(look.nodes, id, "dim");
        if (
          shownView.level !== level.id &&
          hasLevel(id) &&
          [shownView.level, ...ancestors(shownView.level)].includes(id)
        ) {
          look.corner.set(id, { text: "view inside ›", className: "" });
        }
      }
    }
  }

  // An element with a level of its own says so.
  for (const id of level.nodes) {
    if (hasLevel(id) && !look.corner.has(id)) look.corner.set(id, { text: "open ›", className: "faint" });
  }

  // What's selected.
  const selected = state.selected;
  if (selected !== undefined) {
    const [kind, ...rest] = selected.split(":");
    const id = rest.join(":");
    if (kind === "el") addClass(look.nodes, id, "selected");
    if (kind === "rel") {
      for (const edge of level.edges) if (edge.relationships.includes(id)) addClass(look.edges, edge.id, "selected");
    }
    if (kind === "drift") {
      for (const edge of level.drift) if (edge.drift.includes(id)) addClass(look.edges, edge.id, "selected");
    }
    if (kind === "off") {
      const off = (view()?.trace?.tests ?? []).flatMap((test) => test.offPath)[Number(id)];
      for (const edge of all) {
        if (off !== undefined && edge.source === off.source && edge.destination === off.destination) {
          addClass(look.edges, edge.id, "selected");
        }
      }
    }
  }
  return look;
}

// A box's outline, in the shape its kind calls for. Returns where the box's text area starts and ends.
function drawShape(parent: SVGElement, shapeName: string, box: Rect): { top: number; bottom: number } {
  const { x, y, width: w, height: h } = box;
  const shape = (name: string, attributes: Record<string, string | number>) =>
    svg(name, { class: "shape", ...attributes }, parent);
  const line = (d: string) => svg("path", { d, class: "shape-line" }, parent);
  switch (shapeName) {
    case "Person":
      svg("circle", { cx: x + w / 2, cy: y + 12, r: 11, class: "shape" }, parent);
      shape("rect", { x, y: y + 20, width: w, height: h - 20, rx: 18 });
      return { top: y + 20, bottom: y + h };
    case "Cylinder": {
      const ry = 7;
      shape("path", {
        d: `M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 1 ${x},${y + h - ry} Z`,
      });
      line(`M${x},${y + ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + ry}`);
      return { top: y + 2 * ry, bottom: y + h - ry };
    }
    case "Pipe": {
      const rx = 9;
      shape("path", {
        d: `M${x + rx},${y} H${x + w - rx} A${rx},${h / 2} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${h / 2} 0 0 1 ${x + rx},${y} Z`,
      });
      line(`M${x + w - rx},${y} A${rx},${h / 2} 0 0 0 ${x + w - rx},${y + h}`);
      return { top: y, bottom: y + h };
    }
    case "WebBrowser":
      shape("rect", { x, y, width: w, height: h, rx: 6 });
      line(`M${x},${y + 13} H${x + w}`);
      for (const i of [0, 1, 2]) svg("circle", { cx: x + 9 + i * 7, cy: y + 6.5, r: 2, class: "shape-dot" }, parent);
      return { top: y + 13, bottom: y + h };
    case "MobileDevice":
      shape("rect", { x, y, width: w, height: h, rx: 12 });
      line(`M${x + w / 2 - 12},${y + 6} H${x + w / 2 + 12}`);
      return { top: y + 8, bottom: y + h - 4 };
    case "Folder":
      shape("path", {
        d: `M${x},${y + 3} Q${x},${y} ${x + 3},${y} H${x + 56} L${x + 66},${y + 10} H${x + w} V${y + h} H${x} Z`,
      });
      return { top: y + 10, bottom: y + h };
    case "Hexagon":
      shape("path", {
        d: `M${x + 16},${y} H${x + w - 16} L${x + w},${y + h / 2} L${x + w - 16},${y + h} H${x + 16} L${x},${y + h / 2} Z`,
      });
      return { top: y, bottom: y + h };
    case "RoundedBox":
      shape("rect", { x, y, width: w, height: h, rx: 18 });
      return { top: y, bottom: y + h };
    default:
      shape("rect", { x, y, width: w, height: h, rx: 6 });
      return { top: y, bottom: y + h };
  }
}

// The point halfway along a route's points.
function midpoint(points: Point[]): Point {
  const lengths = points.slice(1).map((point, i) => Math.hypot(point[0] - points[i]![0], point[1] - points[i]![1]));
  let walk = lengths.reduce((sum, each) => sum + each, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    const run = lengths[i]!;
    if (walk <= run) {
      const t = run === 0 ? 0 : walk / run;
      const [a, b] = [points[i]!, points[i + 1]!];
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
    walk -= run;
  }
  return points[points.length - 1] ?? [0, 0];
}

function arrowhead(points: Point[]): string {
  const end = points[points.length - 1]!;
  // The last point that isn't the end itself gives the direction.
  let from = points[points.length - 2] ?? end;
  for (let i = points.length - 2; i >= 0 && from[0] === end[0] && from[1] === end[1]; i--) from = points[i]!;
  const angle = Math.atan2(end[1] - from[1], end[0] - from[0]);
  const [a, s] = [8, 4];
  const p1 = [end[0] - a * Math.cos(angle) + s * Math.sin(angle), end[1] - a * Math.sin(angle) - s * Math.cos(angle)];
  const p2 = [end[0] - a * Math.cos(angle) - s * Math.sin(angle), end[1] - a * Math.sin(angle) + s * Math.cos(angle)];
  const at = (p: number[]) => `${p[0]!.toFixed(1)},${p[1]!.toFixed(1)}`;
  return `M${at(end)} L${at(p1)} L${at(p2)} Z`;
}

let natural = { width: 0, height: 0 };

function drawMap(): void {
  const level = levelsById.get(state.level);
  const layout = layouts()[state.level];
  const canvas = byId("canvas");
  if (level === undefined || layout === undefined) {
    canvas.replaceChildren();
    return;
  }
  const visible = shown(data, level, modeOf());
  const look = lookOf(level);
  natural = { width: layout.width + 2 * pad, height: layout.height + 2 * pad };
  const root = svg("svg", {
    class: "diagram",
    role: "group",
    "aria-label": level.title,
    viewBox: `${-pad} ${-pad} ${natural.width} ${natural.height}`,
  });

  if (layout.boundary !== undefined && level.scope !== undefined) {
    const g = svg("g", { class: "boundary" }, root);
    const b = layout.boundary;
    svg("rect", { x: b.x, y: b.y, width: b.width, height: b.height, rx: 10, class: "boundary-box" }, g);
    svgText(g, E[level.scope]?.name ?? level.scope, { x: b.x + 14, y: b.y + 21, class: "boundary-name" });
  }

  const edgesLayer = svg("g", { class: "edges" }, root);
  const nodesLayer = svg("g", { class: "nodes" }, root);
  const labelsLayer = svg("g", { class: "labels" }, root);

  const drawn = new Map<string, Point[]>();
  for (const edge of [
    ...level.edges,
    ...level.drift.map((each) => ({ ...each, label: "undeclared", drifted: true })),
  ]) {
    if (!visible.edges.has(edge.id)) continue;
    const route = layout.routes[edge.id];
    if (route === undefined || route.points.length < 2) continue;
    drawn.set(edge.id, route.points);
    const className = `edge ${look.edges.get(edge.id) ?? ""}`;
    const g = svg("g", { class: className, "data-id": edge.id }, edgesLayer);
    svg("path", { d: route.d, class: "edge-line" }, g);
    svg("path", { d: arrowhead(route.points), class: "edge-head" }, g);
    const title = svg("title", {}, g);
    title.textContent = `${nameOf(edge.source)} → ${nameOf(edge.destination)}: ${edge.label}`;
    if (route.label !== undefined && edge.label !== "" && !look.quietEdges.has(edge.id)) {
      const lg = svg("g", { class: `edge-label ${look.edges.get(edge.id) ?? ""}` }, labelsLayer);
      const r = route.label;
      svg("rect", { x: r.x - 2, y: r.y, width: r.width + 4, height: r.height, rx: 2, class: "label-back" }, lg);
      // Labels are placed for their width at 11px: the longest are cut to fit.
      svgText(lg, fit(edge.label, Math.max(4, Math.floor((r.width - 6) / 6.4))), { x: r.x, y: r.y + 11 });
    }
  }

  for (const id of level.nodes) {
    if (!visible.nodes.has(id)) continue;
    const element = E[id];
    const box = layout.shapes[id];
    if (element === undefined || box === undefined) continue;
    const classes = [
      "node",
      element.type,
      element.external ? "external" : "",
      element.built === false ? "unbuilt" : "",
      look.nodes.get(id) ?? "",
    ];
    const g = svg(
      "g",
      { class: classes.filter(Boolean).join(" "), "data-id": id, tabindex: 0, role: "button" },
      nodesLayer,
    );
    const opens = hasLevel(id);
    g.setAttribute("aria-label", `${element.kind} ${element.name}${opens ? ", opens its level" : ""}`);
    const title = svg("title", {}, g);
    title.textContent = [`${element.kind}: ${element.name}`, element.technology, element.description, element.path]
      .filter((part) => part !== undefined && part !== "")
      .join("\n");
    const { top, bottom } = drawShape(g, element.shape, box);
    const cx = box.x + box.width / 2;
    const kind = `${element.kind}${element.external ? ", external" : ""}`;
    const rows: Array<[string, string, number]> = [
      ["kind", fit(kind, 28), 14],
      ["name", fit(element.name, 22), 17],
      ...(element.technology === "" ? [] : [["tech", fit(element.technology, 26), 14] as [string, string, number]]),
    ];
    const height = rows.reduce((sum, [, , h]) => sum + h, 0);
    const corner = look.corner.get(id);
    // Text at the top right moves the rest down a little, clear of it.
    let y = top + (bottom - top) / 2 - height / 2 + (corner === undefined || element.shape === "Person" ? 0 : 4);
    for (const [part, text, h] of rows) {
      y += h;
      svgText(g, text, { x: cx, y: y - 4, class: `node-${part}`, "text-anchor": "middle" });
    }
    if (corner !== undefined) {
      svgText(g, corner.text, {
        x: box.x + box.width - 8,
        y: (element.shape === "Person" ? top : box.y) + 13,
        class: `corner ${corner.className}`,
        "text-anchor": "end",
      });
    }
    const act = () => (opens ? goTo(id) : select(`el:${id}`));
    g.addEventListener("click", act);
    g.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        act();
      }
    });
  }

  // The dynamic view's steps, numbered on their edges.
  if (state.tab === "behaviour") {
    const shownView = view();
    const untested = new Set(shownView?.trace?.untested ?? []);
    for (const [edgeId, indexes] of stepsOnEdges(level, shownView)) {
      const points = drawn.get(edgeId);
      if (points === undefined || shownView === undefined) continue;
      const [mx, my] = midpoint(points);
      indexes.forEach((index, i) => {
        const step = shownView.steps[index]!;
        const classes = ["badge", untested.has(index) ? "untested" : "", state.step === index ? "current" : ""];
        const g = svg("g", { class: classes.filter(Boolean).join(" "), role: "button", tabindex: 0 }, labelsLayer);
        g.setAttribute("aria-label", `Step ${step.order}: ${step.description}`);
        const x = mx + (i - (indexes.length - 1) / 2) * 22;
        svg("circle", { cx: x.toFixed(1), cy: my.toFixed(1), r: 9 }, g);
        svgText(g, step.order, { x: x.toFixed(1), y: (my + 3.5).toFixed(1), "text-anchor": "middle" });
        const title = svg("title", {}, g);
        title.textContent = `${step.order}. ${step.description}`;
        g.addEventListener("click", () => select(`step:${index}`));
      });
    }
  }

  canvas.replaceChildren(root);
  applyZoom();
}

// ---- Zoom: fit to the width, never below a readable scale.

const readable = 0.7;

function fitScale(): number {
  const canvas = byId("canvas");
  const room = canvas.clientWidth - 32;
  if (natural.width === 0 || room <= 0) return 1;
  return Math.min(1.15, Math.max(readable, room / natural.width));
}

function currentScale(): number {
  return state.zoom ?? fitScale();
}

function setZoom(zoom: number | undefined): void {
  state.zoom = zoom === undefined ? undefined : Math.min(3, Math.max(0.3, zoom));
  drawControls();
  applyZoom();
}

function applyZoom(): void {
  const diagram = byId("canvas").querySelector("svg");
  if (diagram === null) return;
  const scale = currentScale();
  diagram.setAttribute("width", (natural.width * scale).toFixed(0));
  diagram.setAttribute("height", (natural.height * scale).toFixed(0));
}

// ---- Putting it together.

function layouts(): Record<string, LevelLayout> {
  return payload.layouts;
}

function draw(): void {
  if (!levelsById.has(state.level)) state.level = data.levels[0]?.id ?? "context";
  drawTabs();
  drawCrumbs();
  drawControls();
  drawPanel();
  drawMap();
  writeHash();
}

readHash();
drawTitle();
draw();

window.addEventListener("hashchange", () => {
  readHash();
  draw();
});
window.addEventListener("resize", () => {
  if (state.zoom === undefined) applyZoom();
});
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (target instanceof Element && target.closest("select, input, textarea") !== null) return;
  const tab = tabs[Number(event.key) - 1];
  if (tab !== undefined && /^[1-4]$/.test(event.key)) {
    setTab(tab);
    document.getElementById(`tab-${tab}`)?.focus();
  }
});
