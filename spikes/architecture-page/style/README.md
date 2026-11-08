# The architecture page's style

The style guide for the architecture page (#116), settled in #117. `bearing page` (#120) builds against it.
`round-3/tabs.html` is the reference mock-up: open it in a browser. The earlier rounds are kept to show what was
tried and rejected.

The mock-ups draw the Basket demo PR from `../demo.sh`. Its layout and target changes are real; its code changes,
traces, check results and drift advice are made up, under `mock` in `round-1/data.js`, so every state shows once.

## Structure

- **One map, four tabs.** The map of the architecture fills the left; the tabs above it split the review in reading
  order: **Target**, **Code**, **Build**, **Behaviour**. The findings panel is on the right.
- **Each tab's counter is its result**, e.g. `+3 ~1`, `+283 −9`, `1 undeclared`, `3 untested`. A tab that needs the
  reviewer has a red counter. The tab bar is the summary: there's no separate list of checks. A tab with nothing to
  report keeps its place with a quiet counter, e.g. `no change`, so every page has the same shape.
- **The level stays put.** Switching tabs never moves the map to another level. A finding on another level says where,
  as a link (`Basket API ›`), and a box with a level of its own shows what's inside it for the current tab
  (`246 inside ›`, `+2 inside ›`). Clicking such a box opens its level; the breadcrumb goes back up.
- **The panel lists findings under short headings with counts**, never questions or sentences:
  - Target: Added, Removed, Changed, ADR. Before / Change / After above the map.
  - Code: Components (most lines first, each with a bar of its share), Outside the model. A key above the map.
  - Build: Undeclared, then one line on what matches, e.g. `Deployment: matches.`
  - Behaviour: the view's title, the test that took it (`#5/AC1 stops after step 8`), then its steps. A view picker
    above the map, with the PR's new and changed views first.
- **Selecting an item** opens its detail in the panel (files, the drift advice, the ADR's reason) and marks it on the
  map. Long explanations appear only there.
- **Number keys** 1 to 4 switch tabs. The URL hash holds the tab, level, view and step.
- **No page for a PR that changes Bearing's workflows or config** (see #116), so there's no tab for that.

## Theme

Dark first, since that's what the maintainer reviews in. Light follows the reader's system setting, with the same
roles. The light values aren't mocked yet: check them when #120 builds the page.

Text needs 4.5:1 against what it sits on and lines and marks 3:1 (WCAG AA). The ratios below are against the map's
background.

| Token | Dark | Light | Used for | Dark ratio |
| --- | --- | --- | --- | --- |
| `--map` | `#0e1822` | `#f6f8fa` | The map, with a dot grid in `--grid` | |
| `--grid` | `#1d2d3b` | `#dde3e9` | The map's dots | |
| `--chrome` | `#080d12` | `#ffffff` | Header, tab bar and side panel | |
| `--chrome-line` | `#1a2530` | `#d8dee4` | Rules and borders in the chrome | |
| `--chrome-hover` | `#0f1821` | `#eef2f5` | Hovered and selected rows | |
| `--node` | `#13222f` | `#ffffff` | Box fill | |
| `--node-line` | `#56718a` | `#7f8c99` | Box outlines | 3.5 |
| `--edge` | `#6d8498` | `#7b8794` | Relationships | 4.6 |
| `--text` | `#dce6ee` | `#1f2933` | Names, values | 14.2 |
| `--muted` | `#8da1b3` | `#52606d` | Kinds, technology, secondary text | 6.7 |
| `--faint` | `#788ea1` | `#5f6b78` | Paths, counts in headings, notes | 5.3 |
| `--added` | `#5ed3c3` | `#0f7b6c` | Target: added and changed | 9.9 |
| `--drift` | `#ff6b81` | `#c4314b` | Build: undeclared; tabs that need the reviewer; code outside the model | 6.5 |
| `--untested` | `#ffb25b` | `#9a5b00` | Behaviour: steps no test takes | 10.0 |
| `--heat-1` … `--heat-4` | `#3b3324` `#6e5026` `#b9802f` `#ffb25b` | `#fde7c4` `#f7c27a` `#e0952e` `#a35c00` | Code: box fill by lines changed | |
| `--on-heat` | `#1c1306` | `#ffffff` | Text on the two brightest heat steps (dark), the darkest (light) | 5.4+ |

On a heat box, every label uses `--text` or `--on-heat`, never `--muted`, which drops below 3:1 on `--heat-2`.

### Colour carries one meaning per tab

Each tab uses one accent: Target `--added`, Code the heat steps, Build `--drift`, Behaviour `--text` and `--untested`.
Under deuteranopia `--added` and `--drift` come close in lightness (1.25:1), so they're never the only thing telling
two marks apart. Each mark has a cue besides colour:

| Mark | Cue besides colour |
| --- | --- |
| Added element | Thicker outline, kind label in the accent; `+` in the panel |
| Changed relationship | Dashed |
| Undeclared relationship | Thicker, labelled `undeclared` |
| Component with no code yet | Dashed outline, faded text, `no code yet` in the panel |
| External system | Dotted outline, `external` in its kind |
| Untested step | Dashed, `no test takes it` in the step's title |
| Heat | Stepped fill with a key, and the `+n −n` figure on the box |
| Everything not in the current tab's concern | Dimmed to 20%, with its label hidden |

## Type

- **IBM Plex Mono** for the chrome (title, tab names and counters, panel headings and rows) and for anything that is
  code: paths, `file.ts:14`, line counts, calls such as `getBasket()`, the branch and commit.
- **IBM Plex Sans** for the diagram's boxes and for longer explanations opened in the panel, which read better in
  proportional type.
- Sizes: 14px base; 12–13px in the chrome; 13.5px box names (600), 11px kind and technology; 11–12px edge labels.
  The title reads like a command line: `$ Share a basket by email`.

## Diagram

- Boxes 190 × 76 with 6px corners, in the shape their kind calls for (see #116), kind above the name and technology
  below. The scope's boundary is a dotted rounded rectangle with its name top left.
- Splines with a small filled arrowhead. Labels in `--muted` beside their edge; hidden on dimmed edges.
- Dynamic view steps are numbered badges on their edges; the selected step's badge is filled and its edge thickens.
- Heat: four steps by lines changed in the element and everything inside it: 1–9, 10–49, 50–149, 150+. Untouched
  boxes keep `--node`.

## Rounds

| Round | What was tried | Outcome |
| --- | --- | --- |
| 1 | `a-briefing.html`: a linear article. `b-chart.html`: one map with the questions as a route. `c-notes.html`: notes pinned on one diagram. | B's map and diagram style kept; the article and question-and-answer wording rejected. |
| 2 | `tabs.html`: four tabs over B's map, findings in a side panel. | The structure kept. Too sanitised; too many sentences; glow for heat. |
| 3 | `tabs.html`: console chrome, mono type, headings with counts, heat as box fill. `tabs-ide.html`: an IDE-style layout with the panel on the left and a status bar. | The console version chosen. |
