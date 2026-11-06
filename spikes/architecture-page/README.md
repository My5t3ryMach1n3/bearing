# Spike: an interactive architecture page for a PR

Prototype for [#114](https://github.com/My5t3ryMach1n3/bearing/issues/114). This is a reference for building the page into Bearing, not part of Bearing itself, and nothing builds or tests it in CI.

| Path | What it is |
| --- | --- |
| `template.html` | The page: styles and script, with a `/*DATA*/null` placeholder for the PR's data. No external requests. |
| `build.mjs` | Gathers the PR's data from the inputs `bearing report` reads (`loadConfig`, `runChecks`, `gatherReport`, `diffModels`, `buildOverlay`), lays out each diagram with ELK, and writes one HTML file with the data inlined. |
| `demo.sh` | Builds a basket PR that both changes the target, adding basket sharing (basket#16's design), and drifts from it, with the controller importing the repository. Then writes `out/basket.html`. |

## Running it

```sh
npm run build                         # at the repo root: build.mjs imports Bearing from dist/
cd spikes/architecture-page && npm install
./demo.sh                             # writes out/basket.html; open it in a browser
node build.mjs --repo <repo> --base main --out page.html   # any repo with .bearing/config.yaml
```

## What the page does

- **Drill-down:** the system context, each software system's containers and each container's components, as C4 diagrams. Relationships are lifted to each level as Bearing's PR comment lifts them. An element with a level of its own says `open ›` and how many changes (amber) and drifted relationships (red) sit inside it, both on the diagram and in the side bar.
- **Four modes, one layout:** Change marks what the PR adds, removes and changes, in the PR comment's colours. Before and After show the target on each side of the PR. Drift shows the relationships the checks find the code making that the target doesn't declare. Each level is laid out once, over everything every mode can show, so nothing moves when you switch and the difference is easy to see.
- **Dynamic views:** each issue's view, stepped through on its level's diagram, with the steps numbered on their edges and everything else dimmed. When the checks traced the issue, the steps no tagged test takes are amber.
- **Details:** select an element for its description, code path, the issues it serves, its relationships at that level and each field the PR changes. Select a relationship for the relationships behind it, or a drifted one for what to do about it.
- **State in the URL hash:** level, mode, view and step, so a reload or a shared link opens the same place.

## Findings so far

Against the open questions in #114:

- **Self-contained page:** works from `file://` with no server. Laying the diagrams out at build time means the page needs no layout library. The basket page is 75 KB: about 45 KB of template and 30 KB of data and layouts. Inlining ELK to lay out in the browser instead would add about 1.5 MB.
- **Layout:** ELK's layered layout, top to bottom, with each level's scope as a compound node, gives readable C4 diagrams with no hand placement. Left to right was too wide for a page once a level had more than four or five layers. Edge labels sometimes sit away from their edge, and that's the main remaining roughness.
- **elkjs 0.9.3 ignores `elk.json.shapeCoords` and `elk.json.edgeCoords`.** Shapes come back relative to their parent, and edges relative to their `container`, so `build.mjs` moves both to the page's frame.
- **Not tried yet:** uploading the page as a workflow artifact and linking it from the PR comment, artifact lifetime, the deployment view, and models much larger than the basket.
