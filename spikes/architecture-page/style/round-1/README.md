# UI style, round 1

Three mock-ups for #117, all of the same Basket demo PR from `../../demo.sh`, dark theme only. The diagrams' layout and
the model's changes are real. The code changes, traces, check results and drift advice are made up, under `mock` in
`data.js`, so every state shows once. `diagram.js` is a throwaway renderer shared by the three.

| File | Idea |
| --- | --- |
| `a-briefing.html` | A linear read, top to bottom: each question answered in a sentence, with its own diagram cropped to only what it's about. |
| `b-chart.html` | One map of the architecture beside the four questions as a route. Picking a question relights the map for it; the rest dims. Add `#stop=2` to open a stop. |
| `c-notes.html` | One quiet diagram with every finding pinned on it as a numbered note, the notes listed by question beside it. Selecting a note focuses the diagram on it. |
