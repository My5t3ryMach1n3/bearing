# B-02 Define and load `.bearing/config.yaml`

**Milestone:** M0 Foundations  
**Labels:** area:cli  
**Depends on:** B-01

Parse and validate the config from the spec's How it works section (model path, Structurizr runner, language, test command and tag, IaC paths, self-heal attempts, advisory checks).

- [ ] JSON Schema for `version: 1`, with clear errors naming the bad key
- [ ] Typed loader used by every command
- [ ] Language is stored internally as a list, so M2 can add `languages` without a breaking change; only `typescript` is accepted for now
