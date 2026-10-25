## Bearing

- To design or revise the target, follow {{skill}}: it runs `bearing context --issues`, writes {{model}}, records key
  choices as ADRs in {{adrs}}/ and ends with `bearing validate`.
- Before coding an issue, run `bearing context #<issue>`; keep code inside the component paths it lists.
- Tag every integration test with its criterion, e.g. `{{tagExample}}`.
- For criteria that depend on time, such as expiry, pass the clock in as a dependency so tests set the time instead
  of waiting.
- Before pushing: `bearing claim`, `bearing test -- {{integration}}`, `bearing check`.
- If a check fails, fix the code within the target. After {{attempts}} failed attempts, propose a target change in
  {{model}} with the reason and the alternatives you considered.
- Never edit .bearing/config.yaml or anything in .github/workflows/.
