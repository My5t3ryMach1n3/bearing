import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { isMap, isSeq, LineCounter, parseAllDocuments, type Node } from "yaml";
import type { Config } from "./config.js";
import {
  IacError,
  matchNodes,
  type DeploymentGraph,
  type FoundNode,
  type IacResource,
  type NodeMapping,
  type SourceRules,
} from "./deployment.js";
import type { Model } from "./model.js";

export class KubernetesError extends IacError {
  constructor(message: string) {
    super(message);
    this.name = "KubernetesError";
  }
}

// One object in a manifest file.
export interface Manifest {
  // The API group from `apiVersion`, "" for the core group: "apps" for "apps/v1", "" for "v1".
  group: string;
  kind: string;
  name: string;
  namespace?: string;
  // "<kind>/<name>", or "<kind>/<namespace>/<name>" when the manifest sets a namespace.
  address: string;
  // Repo-relative, with forward slashes.
  file: string;
  line: number;
  // `metadata.labels`, keeping only string values.
  labels: Record<string, string>;
  spec: Record<string, unknown>;
}

interface Mapping extends NodeMapping {
  // Whether `spec.replicas` holds how many instances the node runs.
  replicas?: boolean;
}

const loadBalancer: Mapping = {
  type: "infrastructureNode",
  technology: "Kubernetes LoadBalancer Service",
  matches: /load balanc|\b[ang]lb\b|\belb\b/i,
};

// The kinds that stand for a deployment node, keyed "<group>/<kind>", or "<kind>" for the core group. A Service is
// a node only when its type is LoadBalancer. Keep in step with the table in docs/product-spec.md.
export const kindMappings: Record<string, Mapping> = {
  "apps/Deployment": {
    type: "deploymentNode",
    technology: "Kubernetes Deployment",
    matches: /\bdeployment\b/i,
    replicas: true,
  },
  "apps/StatefulSet": {
    type: "deploymentNode",
    technology: "Kubernetes StatefulSet",
    matches: /stateful ?set/i,
    replicas: true,
  },
  "apps/DaemonSet": { type: "deploymentNode", technology: "Kubernetes DaemonSet", matches: /daemon ?set/i },
  "apps/ReplicaSet": {
    type: "deploymentNode",
    technology: "Kubernetes ReplicaSet",
    matches: /replica ?set/i,
    replicas: true,
  },
  Pod: { type: "deploymentNode", technology: "Kubernetes Pod", matches: /\bpods?\b/i },
  "batch/Job": { type: "deploymentNode", technology: "Kubernetes Job", matches: /^(?!.*cron).*\bjob\b/i },
  "batch/CronJob": { type: "deploymentNode", technology: "Kubernetes CronJob", matches: /cron ?job/i },
  "networking.k8s.io/Ingress": { type: "infrastructureNode", technology: "Kubernetes Ingress", matches: /ingress/i },
};

// The kinds that configure, connect or secure a node rather than being one, keyed as `kindMappings` is. Keep in
// step with docs/product-spec.md.
export const supportingKinds = [
  "ConfigMap",
  "Endpoints",
  "LimitRange",
  "Namespace",
  "PersistentVolume",
  "PersistentVolumeClaim",
  "ResourceQuota",
  "Secret",
  "Service",
  "ServiceAccount",
  "autoscaling/HorizontalPodAutoscaler",
  "discovery.k8s.io/EndpointSlice",
  "networking.k8s.io/IngressClass",
  "networking.k8s.io/NetworkPolicy",
  "policy/PodDisruptionBudget",
  "rbac.authorization.k8s.io/ClusterRole",
  "rbac.authorization.k8s.io/ClusterRoleBinding",
  "rbac.authorization.k8s.io/Role",
  "rbac.authorization.k8s.io/RoleBinding",
  "scheduling.k8s.io/PriorityClass",
  "storage.k8s.io/StorageClass",
];

// A target deployment node names the object it stands for with this property, e.g.
// `"bearing.kubernetes" "Deployment/booking-api"`, when its name isn't the object's.
export const kubernetesProperty = "bearing.kubernetes";

// Each workload is a node of its own, so a target node holding instances and no other node is compared whatever its
// technology: a "PostgreSQL" node is the StatefulSet that runs it.
export const kubernetesRules: SourceRules = {
  source: "kubernetes",
  key: "iac.kubernetes",
  property: kubernetesProperty,
  mappings: [...Object.values(kindMappings), loadBalancer],
  workloads: true,
};

const keyOf = (manifest: Manifest) => (manifest.group === "" ? manifest.kind : `${manifest.group}/${manifest.kind}`);

// Reads the manifests in `iac.kubernetes` and turns each object of a mapped kind into a deployment node, matched with
// the target's as `matchNodes` matches them.
export function deriveKubernetes(config: Config, target: Model, manifests = readKubernetes(config)): DeploymentGraph {
  const { found, unknown } = kubernetesNodes(manifests);
  return matchNodes(target, kubernetesRules, found, unknown);
}

// The deployment nodes in the manifests, each with the target's ID still to find, and the objects Bearing doesn't
// map.
export function kubernetesNodes(manifests: Manifest[]): { found: FoundNode[]; unknown: IacResource[] } {
  const found: FoundNode[] = [];
  const unknown: IacResource[] = [];
  for (const manifest of manifests) {
    const key = keyOf(manifest);
    const resource = { address: manifest.address, file: manifest.file, line: manifest.line };
    const mapping = key === "Service" && manifest.spec.type === "LoadBalancer" ? loadBalancer : kindMappings[key];
    if (mapping === undefined) {
      if (!supportingKinds.includes(key)) unknown.push(resource);
      continue;
    }
    const node: FoundNode["node"] = {
      id: manifest.address,
      type: mapping.type,
      technology: mapping.technology,
      resource,
    };
    const replicas = manifest.spec.replicas;
    if (mapping.replicas === true && typeof replicas === "number" && Number.isInteger(replicas) && replicas >= 0) {
      node.instances = String(replicas);
    }
    found.push({ node, mapping, name: manifest.name });
  }
  return { found, unknown };
}

// Every object in the `.yaml`, `.yml` and `.json` files in `iac.kubernetes`, as `kubectl apply -f <dir>` reads them:
// subfolders aren't read, and a `List` stands for its items.
export function readKubernetes(config: Config): Manifest[] {
  const dir = config.iac.kubernetes;
  if (dir === undefined) throw new KubernetesError('"iac.kubernetes" is not set in .bearing/config.yaml');
  const repoDir = posix.normalize(dir.split("\\").join("/"));
  const absolute = resolve(config.root, dir);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new KubernetesError(`${repoDir} not found; check "iac.kubernetes" in .bearing/config.yaml`);
  }
  // A chart's templates aren't manifests until Helm renders them.
  const chart = [absolute, join(absolute, "..")].find((at) => existsSync(join(at, "Chart.yaml")));
  if (chart !== undefined) {
    throw new KubernetesError(
      `${repoDir} is a Helm chart; render it with \`helm template\` into a folder and point "iac.kubernetes" at that`,
    );
  }
  return readdirSync(absolute)
    .filter((name) => /\.(ya?ml|json)$/.test(name) && statSync(join(absolute, name)).isFile())
    .sort()
    .flatMap((name) => parseManifests(readFileSync(join(absolute, name), "utf8"), posix.join(repoDir, name)));
}

// The objects in one manifest file, which may hold several YAML documents.
export function parseManifests(text: string, file: string): Manifest[] {
  const lines = new LineCounter();
  const lineOf = (node: Node | null | undefined) => (node?.range ? lines.linePos(node.range[0]).line : 1);
  const manifests: Manifest[] = [];
  for (const document of parseAllDocuments(text, { lineCounter: lines })) {
    const error = document.errors[0];
    if (error !== undefined) {
      const line = lines.linePos(error.pos[0]).line;
      throw new KubernetesError(`${file}:${line}: ${error.message.split("\n")[0]}`);
    }
    if (document.contents === null) continue;
    const add = (node: Node | null) => {
      const line = lineOf(node);
      const value: unknown = node?.toJSON();
      if (value === null || value === undefined) return;
      const object = value as Record<string, unknown>;
      if (typeof object !== "object" || Array.isArray(object) || typeof object.kind !== "string") {
        throw new KubernetesError(`${file}:${line}: not a Kubernetes object: it has no kind`);
      }
      if (object.kind === "List" && isMap(node)) {
        const items = node.get("items", true);
        if (isSeq(items)) for (const item of items.items) add(item as Node);
        return;
      }
      manifests.push(manifestOf(object, file, line));
    };
    add(document.contents);
  }
  return manifests;
}

function manifestOf(object: Record<string, unknown>, file: string, line: number): Manifest {
  const kind = object.kind as string;
  const apiVersion = typeof object.apiVersion === "string" ? object.apiVersion : "";
  const group = apiVersion.includes("/") ? apiVersion.slice(0, apiVersion.lastIndexOf("/")) : "";
  const metadata = (typeof object.metadata === "object" && object.metadata !== null ? object.metadata : {}) as Record<
    string,
    unknown
  >;
  if (typeof metadata.name !== "string" || metadata.name === "") {
    throw new KubernetesError(`${file}:${line}: the ${kind} has no metadata.name`);
  }
  const name = metadata.name;
  const namespace =
    typeof metadata.namespace === "string" && metadata.namespace !== "" ? metadata.namespace : undefined;
  const spec = (typeof object.spec === "object" && object.spec !== null ? object.spec : {}) as Record<string, unknown>;
  const labels = stringMap(metadata.labels);
  return {
    group,
    kind,
    name,
    ...(namespace === undefined ? {} : { namespace }),
    address: namespace === undefined ? `${kind}/${name}` : `${kind}/${namespace}/${name}`,
    file,
    line,
    labels,
    spec,
  };
}

// The string values of an object, such as a label map or a selector. Anything else reads as empty.
export function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
