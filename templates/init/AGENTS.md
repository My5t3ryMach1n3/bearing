## Bearing

- To design, run `bearing context --issues`, write {{model}}, then `bearing validate`.
- Before coding an issue, run `bearing context #<issue>`; keep code inside the component paths it lists.
- Tag every integration test with its criterion, e.g. `{{tagExample}}`.
- Before pushing: `bearing claim`, `bearing test -- {{integration}}`, `bearing check`.
- If a check fails, fix the code within the target. After {{attempts}} failed attempts, propose a target change in
  {{model}} with the reason and the alternatives you considered.
- Never edit .bearing/config.yaml or anything in .github/workflows/.
