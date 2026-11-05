# Clinic fixture

Chairside from the [worked example](https://claude.ai/code/artifact/4b47956a-6da1-4208-a2cf-df0dd14c2e04), hosted on the clinic's own server instead of AWS: the web app, the booking API and PostgreSQL all run in one k3s cluster. It's the fixture for Kubernetes deployments ([#108](https://github.com/My5t3ryMach1n3/bearing/issues/108)). It has no code, since only its deployment is checked.

| Path | What it is |
| --- | --- |
| `repo/` | The clean repo: what main looks like |
| `workspace.json` | `repo/architecture/workspace.dsl` as the pinned Structurizr exports it |
| `variants/<name>/` | Seeded branches, as files laid over `repo/` |

## The repo

- `architecture/workspace.dsl` is the approved target. Its one deployment environment, Clinic, nests the server, the k3s cluster and the `chairside` namespace, which only group the rest. Inside are one node per workload and an Ingress. Each workload node matches its object in a different way: `web` and `Booking API` by name, the `Database server` by its `bearing.kubernetes` property, since the StatefulSet is called `postgres`, and the Ingress by technology.
- `k8s/` holds the manifests, as `helm template` or `kustomize build` would leave them: a Deployment and a Service each for the web app and the booking API, a StatefulSet and a headless Service for PostgreSQL, an Ingress, a Namespace and a ConfigMap.
- `.bearing/config.yaml` sets `iac.kubernetes: k8s/`.

## Variants

| Variant | What it does | What should catch it |
| --- | --- | --- |
| `redis-cache` | Adds a Redis Deployment the target doesn't have | Deployment: `Deployment/chairside/redis` is a node the target doesn't have |
| `scaled-api` | Runs three replicas of the booking API where the target says two | Deployment: the booking API's instances drift |

[`test/kubernetes.test.ts`](../../kubernetes.test.ts) copies the repo, lays a variant over it and runs the Deployment check.
