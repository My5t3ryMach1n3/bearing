# Spike: an interactive architecture page for a PR

Prototype for [#114](https://github.com/My5t3ryMach1n3/bearing/issues/114). This is a reference for building the page into Bearing, not part of Bearing itself. `bearing page` builds the page for real now, and the conformance action uploads it for the PR comment to link; the spike's own workflow is gone.

| Path | What it is |
| --- | --- |
| `template.html` | The page: styles and script, with a `/*DATA*/ null` placeholder for the PR's data. No external requests. |
| `page.mjs` | The page's data: the PR's levels, with what it changes, where the code drifts, each element's kind and shape, and each level laid out by ELK. |
| `build.mjs` | Gathers the PR's data from the inputs `bearing report` reads (`loadConfig`, `runChecks`, `gatherReport`, `loadWorkspace`), and writes one HTML file with the data inlined. |
| `demo.sh` | Builds a basket PR that both changes the target, adding basket sharing (basket#16's design), and drifts from it, with the controller importing the repository. Then writes `out/basket.html`. |
| `bench.mjs` | Compares ELK's options by how many turns the edges take, on the fixtures and a generated shop of about 30 elements. |

## Running it

```sh
npm run build                         # at the repo root: the spike imports Bearing from dist/
cd spikes/architecture-page && npm install
./demo.sh                             # writes out/basket.html; open it in a browser
node build.mjs --repo <repo> --base main --out page.html   # any repo with .bearing/config.yaml
node build.mjs --workspace <workspace.json> --out page.html   # a model on its own, with no PR or checks
node bench.mjs                        # the layout table below
```

`--routing orthogonal|polyline|splines` on `build.mjs` overrides the edge routing, to compare them by eye.

## What the page does

- **Drill-down:** the system context, each software system's containers and each container's components, as C4 diagrams. Relationships are lifted to each level as Bearing's PR comment lifts them. An element with a level of its own says `open ›` and how many changes (amber) and drifted relationships (red) sit inside it, both on the diagram and in the side bar.
- **What each element is:** every box names its kind above its name, and its technology below. The kind and shape come from the workspace's own element styles first, as Structurizr applies them, so a team's `shape Cylinder` for `Database` draws a cylinder here as on the Structurizr site. Failing a style, a container's technology decides: PostgreSQL or Redis is a database, SQS or Kafka a queue, React a web app, iOS a mobile app, S3 a file store. Failing that, a container that code outside it calls over HTTP is an API. External elements are grey.
- **Four modes, one layout:** Change marks what the PR adds, removes and changes, in the PR comment's colours. Before and After show the target on each side of the PR. Drift shows the relationships the checks find the code making that the target doesn't declare. Each level is laid out once, over everything every mode can show, so nothing moves when you switch and the difference is easy to see.
- **Dynamic views:** each issue's view, stepped through on its level's diagram, with the steps numbered on their edges and everything else dimmed. When the checks traced the issue, the steps no tagged test takes are amber.
- **Details:** select an element for its description, code path, the issues it serves, its relationships at that level and each field the PR changes. Select a relationship for the relationships behind it, or a drifted one for what to do about it.
- **State in the URL hash:** level, mode, view and step, so a reload or a shared link opens the same place.

## Layout

`bench.mjs` counts the turns edges take over every level, as bend points for orthogonal and polyline routing and as curves for splines:

| ELK options | Basket, per edge | Generated shop, per edge | Diagram area |
| --- | --- | --- | --- |
| Orthogonal, ELK places the labels (the first version) | 2.0 turns | 2.33 turns | 100% |
| Orthogonal, labels placed after routing | 1.58 | 1.67 | 54–64% |
| … and Brandes–Köpf balanced node placement | 1.46 | 1.57 | 54–64% |
| … with polyline routing | 0.96 | 0.96 | 55–67% |
| … with spline routing (the default) | 1.03 curves | 0.98 curves | 54–64% |

- **Labels placed after routing** make the biggest difference to how cluttered a diagram looks. ELK turns each label it places into a dummy node that edges route around, which adds turns and spreads the diagram out. Instead, `page.mjs` places each label beside its edge's longer runs, at the first spot clear of every box and every label already placed, longest edges first.
- **Splines** take about one curve per edge and no corners, against about one corner per edge for polyline routing.

## Findings so far

Against the open questions in #114:

- **Self-contained page:** works from `file://` with no server. Laying the diagrams out at build time means the page needs no layout library. The basket page is 80 KB: about 50 KB of template and 30 KB of data and layouts. Inlining ELK to lay out in the browser instead would add about 1.5 MB.
- **Downloading it:** `actions/upload-artifact` v7 and later can upload a single file without zipping it (`archive: false`), so the link in the PR downloads the HTML file itself, ready to open.
- **Layout:** ELK's layered layout, top to bottom, with each level's scope as a compound node, gives readable C4 diagrams with no hand placement. Left to right was too wide for a page once a level had more than four or five layers. What's left is mostly where several edges leave one element: their labels can still crowd together, and a curve can pass behind a box it doesn't connect to.
- **elkjs 0.9.3 ignores `elk.json.shapeCoords` and `elk.json.edgeCoords`.** Shapes come back relative to their parent, and edges relative to their `container`, so `page.mjs` moves both to the page's frame. An edge that crosses a boundary can come in several sections, which `page.mjs` joins. Spline control points don't always come in threes, so the page ends a curve with a quadratic or a straight run.
- **Not tried yet:** artifact lifetime, the deployment view, and real models much larger than the basket.
