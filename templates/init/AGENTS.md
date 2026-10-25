## Bearing

- To design or revise the target, follow the steps `bearing skill` prints: run `bearing context --issues`, write
  {{model}}, record key choices as ADRs in {{adrs}}/, then `bearing validate`.
  If you load skills, you may save them as one with `bearing skill --install`.
- Before coding an issue, run `bearing context #<issue>`; keep code inside the component paths it lists.
- Tag every integration test with its criterion, e.g. `{{tagExample}}`.
- For criteria that depend on time, such as expiry, pass the clock in as a dependency so tests set the time instead
  of waiting.
- Before pushing: `bearing claim`, `bearing test -- {{integration}}`, `bearing check`.
- If a check fails, fix the code within the target. After {{attempts}} failed attempts, propose a target change in
  {{model}} with the reason and the alternatives you considered.
- Never edit .bearing/config.yaml or anything in .github/workflows/.
