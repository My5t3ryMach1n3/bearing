## Bearing

- To design or revise the target, follow the steps `bearing skill` prints: run `bearing context --issues`, write
  {{model}}, record key choices as ADRs in {{adrs}}/, then `bearing validate`.
  If you load skills, offer to save them as one with `bearing skill --install`, and only run it if the user agrees.
- Before coding an issue, run `bearing context #<issue>`; keep code inside the component paths it lists.
- Link a PR to the requirement it delivers with `Closes #<issue>`. A requirement closed as completed stays in the
  target; one closed as not planned is pruned from it, with its code.
- Tag every integration test with its criterion, e.g. `{{tagExample}}`.
- For criteria that depend on time, such as expiry, pass the clock in as a dependency so tests set the time instead
  of waiting.
- Before pushing: `bearing claim`, `bearing test -- {{integration}}`, `bearing check`.
- If a check fails, fix the code within the target. After {{attempts}} failed attempts, propose a target change in
  {{model}} on the same branch, with an ADR from {{adrs}}/template.md giving the reason and the alternatives
  you considered. If another target change merges first, rebase onto it and rework yours on top.
- In the first PR that adds code, check .bearing/config.yaml against the repo as the PR leaves it: set
  `tests.integration` once there's an integration test command, and `iac` once there's Terraform or Kubernetes
  manifests. Say why in the PR description; a code owner approves it. Otherwise never edit .bearing/config.yaml,
  and never edit anything in .github/workflows/.
