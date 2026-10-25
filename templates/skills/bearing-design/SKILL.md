---
name: bearing-design
description: Design the target architecture from the open requirements, revise it after review, or change it for a new requirement. Use when asked to design, draft, revise or change the C4 model in {{model}}, before any code is written for those requirements.
---

# Design the target from requirements

You draft the target architecture: a C4 model in Structurizr DSL that engineers review and merge as the desired state. Every PR is checked against it afterwards, so draw what should be built, no more. You propose; a human approves by merging.

The deliverable is one pull request that changes only {{model}} and {{adrs}}/. No code.

## 1. Read the requirements and rules

Run `bearing context --issues`. It prints every open requirement with its acceptance criteria, then the C4 rules, Bearing's rules and the DSL conventions. Those rules are what `bearing validate` checks, so treat them as hard constraints. Read the repo too: existing code, IaC and the language in use decide where component paths go.

Each issue number is a stable ID. Epics are parent issues: their stories get dynamic views, they don't.

## 2. Walk each story before drawing boxes

For each story, write down the path one request takes to satisfy its criteria: who starts it, which deployable parts it crosses, and which groups of code inside them do the work. The model is the union of these paths. Anything no path needs doesn't go in.

## 3. Draft levels 1 to 3

- **Level 1, system context.** The people from the stories, the software system being built, and every external system a path calls, tagged `"External"`.
- **Level 2, containers.** The deployable parts of the system: apps, services, databases, queues. Give each a technology.
- **Level 3, components.** Only inside the containers whose code lives in this repo. Split by responsibility, so each component is easy to describe in one sentence. Prefer few components that each serve several stories over one per story.
- **Paths.** Give each component one folder of its own, e.g. `src/<container>/<component>`. Folders mustn't nest, and every source file the stories need must fall under one.
- **Relationships.** Declare every relationship a dynamic view step will take, at the level the step uses: component to component, component to database or external system, caller to the first component. Structurizr infers container-level relationships from these; a step along an inferred relationship fails validation.

Use C4's vocabulary only. If a choice needs explaining, such as a datastore, a split or an external dependency, write an ADR (step 7) rather than a comment in the DSL.

## 4. One dynamic view per story

For every open story that isn't an epic, add `dynamic <container> "req-<n>" "#<n> <issue title>"`, scoped to the container its components are in. List the steps in call order, from whatever starts the request to the last datastore or external system it reaches. Label each step with the call it stands for, e.g. `"addItem()"` or `"POST /basket/items"`.

These views are the contract: integration tests tagged with each criterion are traced, and the trace must follow the view. Draw the path you expect the code to take, not a simplified one.

Give each view a `properties` block setting `"bearing.criteria"` to the pin `bearing context --issues` prints for its story. The pin records the criteria the view was drawn for: when someone edits them, `bearing validate` flags the view and the tests tagged with what changed as stale, until they are checked against the new criteria and the view is re-pinned.

## 5. Deployment view

Add a `deploymentEnvironment` with nodes for where each container runs and a `containerInstance` for each. Match the IaC if the repo has it; otherwise describe the setup the engineer asked for, which IaC will later have to match. Infrastructure nodes such as load balancers and CDNs need no requirements.

## 6. Tag everything with requirements

Set `"bearing.requirements"` on every person, system, container, component and relationship. Derive it from the dynamic views: an element or relationship serves an issue when that issue's view passes through it. Parents list the union of their children, so the system lists every issue its containers serve. If something serves no open issue, remove it.

## 7. Record key choices as ADRs

For each choice a reviewer could reasonably question, copy {{adrs}}/template.md to {{adrs}}/NNNN-short-title.md, numbered from 0001. Say which issues forced the choice, what you chose in the model's terms, and the alternatives you rejected with why.

## 8. Validate, then open the PR

Run `bearing validate` and fix every problem it lists. DSL errors come back as `file:line: message`. Repeat until it passes; never weaken a rule by adding requirement IDs that don't apply.

Open a pull request with only the model and the ADRs. In the description, list the containers and components with what each owns, and call out the choices most worth reviewing. Reviewers will walk the dynamic views one issue at a time in Structurizr.

## Revising after review

Make the change in the model, re-derive the requirement tags of anything it touches, update or add ADRs, and run `bearing validate` again before pushing. Reply to each comment with what changed. Don't start coding until the model is merged: that commit is the target.

## A new requirement against a merged target

Change the target as little as the new story needs. Run `bearing context #<n>` for the issues it builds on or links to, read the target and the code they point at, and walk the new story's path as in step 2. Reuse what's there; add or change only what that path can't take. Then add its dynamic view, re-derive the requirement tags of what you touched, and validate. In the PR, list what changed and say why each existing element was enough or wasn't.

## When a requirement changes

- **Its criteria are edited.** `bearing validate` names the stale view and the tests tagged with the changed criteria. Run `bearing context #<n>`, redraw the view if the path changed, then set its `"bearing.criteria"` to the new pin. The tests are code, so update them in the PR that implements the change.
- **It's closed as not planned.** `bearing validate` lists what served only that issue. Remove those elements, relationships and its dynamic view from the target, drop the issue from everything else that lists it, and delete the code under the removed components' paths in the same PR; Surplus flags that code until it goes.

## Skeleton

```text
workspace "<name>" "<one line on the system>" {
  model {
    user = person "<Role>" "<who they are>" {
      properties {
        "bearing.requirements" "#1,#2"
      }
    }
    external = softwareSystem "<Name>" "<what it does>" {
      tags "External"
      properties {
        "bearing.requirements" "#1"
      }
    }
    system = softwareSystem "<Name>" "<what it does>" {
      properties {
        "bearing.requirements" "#1,#2"
      }
      api = container "<Name>" "<what it does>" "<technology>" {
        properties {
          "bearing.requirements" "#1,#2"
        }
        someComponent = component "<Name>" {
          description "<its one responsibility>"
          properties {
            "bearing.path" "src/api/some-component"
            "bearing.requirements" "#1,#2"
          }
        }
      }
    }

    user -> someComponent "<what the user does with it>" "JSON/HTTPS" {
      properties {
        "bearing.requirements" "#1,#2"
      }
    }

    production = deploymentEnvironment "Production" {
      cloud = deploymentNode "<Provider>" {
        service = deploymentNode "<Runtime>" "" "<technology>" {
          containerInstance api
        }
      }
    }
  }

  views {
    systemContext system "context" {
      include *
      autoLayout
    }
    container system "containers" {
      include *
      autoLayout
    }
    component api "components" {
      include *
      autoLayout
    }
    dynamic api "req-1" "#1 <issue title>" {
      user -> someComponent "<the call>"
      autoLayout
      properties {
        "bearing.criteria" "<the pin bearing context prints for #1>"
      }
    }
    deployment system production "deployment" {
      include *
      autoLayout
    }
  }
}
```
