import type { Config } from "./config.js";
import { deploymentModel, type DeploymentGraph } from "./deployment.js";
import { deriveKubernetes, kubernetesRules, type Manifest } from "./kubernetes.js";
import type { Model } from "./model.js";
import { deriveTerraform, readTerraform, terraformRules, type Block } from "./terraform.js";

// The deployment nodes in the IaC `iac` sets, matched with the target's one environment: the Terraform under
// `iac.terraform` or the manifests under `iac.kubernetes`. Undefined when it sets neither. `blocks` saves reading the
// Terraform again when the caller already has, and `manifests` the Kubernetes manifests.
export function deriveDeployment(
  config: Config,
  target: Model,
  blocks: Block[] | undefined = config.iac.terraform === undefined ? undefined : readTerraform(config),
  manifests?: Manifest[],
): DeploymentGraph | undefined {
  if (blocks !== undefined) return deriveTerraform(config, target, blocks);
  if (config.iac.kubernetes !== undefined) return deriveKubernetes(config, target, manifests);
  return undefined;
}

// The as-built deployment the IaC gives, for diffing with the target.
export function asBuiltDeployment(target: Model, graph: DeploymentGraph): Model {
  return deploymentModel(target, graph, graph.source === "kubernetes" ? kubernetesRules : terraformRules);
}
