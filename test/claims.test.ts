import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimFile,
  ClaimError,
  draftClaim,
  forkPoint,
  formatClaim,
  issuesInBranch,
  parseClaim,
  readClaim,
} from "../src/claims.js";
import { loadConfig } from "../src/config.js";
import { basketDir, copyBasket, type BasketVariant } from "./basket.js";

const claimed = ["controller-imports-repository", "untraced-helper", "wrong-place"] as const;
const fixtureClaim = (variant: BasketVariant) =>
  readFileSync(join(basketDir, "variants", variant, ".bearing", "claims", `${variant}.yaml`), "utf8");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" });
}

// The basket repo as a git repo with main committed, reading its target from the exported workspace JSON so
// no test runs Structurizr.
function basketRepo(): string {
  const root = copyBasket();
  cpSync(join(basketDir, "workspace.json"), join(root, "architecture", "workspace.json"));
  const config = join(root, ".bearing", "config.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("workspace.dsl", "workspace.json"));
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "main");
  return root;
}

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe("claimFile", () => {
  it("keeps a plain branch name", () => {
    expect(claimFile("issue-2-add-item")).toBe(join(".bearing", "claims", "issue-2-add-item.yaml"));
  });

  it("encodes slashes and other unsafe characters, so no two branches share a file", () => {
    expect(claimFile("feat/issue-2")).toBe(join(".bearing", "claims", "feat%2Fissue-2.yaml"));
    expect(claimFile("a%2Fb")).toBe(join(".bearing", "claims", "a%252Fb.yaml"));
    expect(claimFile('x<y>|"é')).toBe(join(".bearing", "claims", "x%3Cy%3E%7C%22%C3%A9.yaml"));
  });
});

describe("issuesInBranch", () => {
  it.each([
    ["issue-2-add-item", ["#2"]],
    ["issues/2", ["#2"]],
    ["2-add-item", ["#2"]],
    ["feat/12-share/issue_4", ["#12", "#4"]],
    ["v2-migration", []],
    ["add-item-2", []],
    ["main", []],
  ])("%s works on %j", (branch, issues) => {
    expect(issuesInBranch(branch)).toEqual(issues);
  });
});

describe("parseClaim", () => {
  it.each(claimed)("reads the %s fixture", (variant) => {
    expect(parseClaim(fixtureClaim(variant), "claim.yaml")).toMatchObject({ branch: variant, issues: ["#2"] });
  });

  it("reads the spec example", () => {
    const text = `branch: issue-2-add-item
issues: ["#2"]
model:
  added: []
  removed: []
files:
  - path: src/basket-api/basket-service/addItem.ts
    component: basketService
note: "Implements #2 within existing components."
`;
    expect(parseClaim(text, "claim.yaml")).toEqual({
      branch: "issue-2-add-item",
      issues: ["#2"],
      model: { added: [], removed: [] },
      files: [{ path: "src/basket-api/basket-service/addItem.ts", component: "basketService" }],
      note: "Implements #2 within existing components.",
    });
  });

  it("lists every problem", () => {
    const text = `branch: x
issues: [2]
model:
  added: []
files:
  - component: basketService
note: ""
extra: true
`;
    expect(() => parseClaim(text, "claim.yaml")).toThrow(ClaimError);
    expect(() => parseClaim(text, "claim.yaml")).toThrow(
      [
        "claim.yaml:",
        '  - "(root)" has unknown key "extra"',
        '  - "issues.0" must be string',
        `  - "model" must have required property 'removed'`,
        `  - "files.0" must have required property 'path'`,
      ].join("\n"),
    );
  });

  it("reports YAML errors", () => {
    expect(() => parseClaim("branch: [x\n", "claim.yaml")).toThrow(/^claim\.yaml: /);
  });
});

describe("formatClaim", () => {
  it.each(claimed)("writes the %s fixture back as it is", (variant) => {
    expect(formatClaim(parseClaim(fixtureClaim(variant), "claim.yaml"))).toBe(fixtureClaim(variant));
  });
});

describe("draftClaim", () => {
  // Each agent variant's own claims file is honest about its files and model, so drafting from the variant's diff
  // gives the same, less the issues and note the agent adds.
  it.each(claimed)("drafts the %s fixture's files and model", async (variant) => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", variant);
    cpSync(join(basketDir, "variants", variant), root, { recursive: true });
    rmSync(join(root, ".bearing", "claims"), { recursive: true });
    const config = loadConfig(root);
    const draft = await draftClaim(config, { branch: variant, base: await forkPoint(root) });
    const { model, files } = parseClaim(fixtureClaim(variant), "claim.yaml");
    expect(draft).toEqual({ branch: variant, issues: [], model, files, note: "" });
  });

  it("claims what the target adds, with the issues it serves", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "share-basket");
    const workspacePath = join(root, "architecture", "workspace.json");
    const workspace = JSON.parse(readFileSync(workspacePath, "utf8"));
    const basketApi = workspace.model.softwareSystems
      .flatMap((system: { containers?: unknown[] }) => system.containers ?? [])
      .find((container: { components?: unknown[] }) => container.components !== undefined);
    basketApi.components.push({
      id: "900",
      name: "Basket sharing",
      description: "Emails a copy of the basket",
      tags: "Element,Component",
      properties: {
        "structurizr.dsl.identifier": "basketSharing",
        "bearing.path": "src/basket-api/basket-sharing",
        "bearing.requirements": "#5",
      },
      relationships: [{ id: "901", sourceId: "900", destinationId: "7", description: "Checks tokens with" }],
    });
    writeFileSync(workspacePath, JSON.stringify(workspace));
    write(root, "src/basket-api/basket-sharing/index.ts", "export const share = () => {};\n");
    write(root, "src/server.ts", "export {};\n");
    write(root, "src/basket-api/basket-sharing/index.test.ts", "export {};\n");
    write(root, "src/basket-api/basket-sharing/types.d.ts", "export {};\n");
    write(root, "docs/sharing.md", "# Sharing\n");

    const draft = await draftClaim(loadConfig(root), { branch: "share-basket", base: await forkPoint(root) });
    expect(draft).toEqual({
      branch: "share-basket",
      issues: ["#5"],
      model: { added: ["basketSharing", "basketSharing->authMiddleware"], removed: [] },
      files: [
        { path: "src/basket-api/basket-sharing/index.ts", component: "basketSharing" },
        { path: "src/server.ts" },
      ],
      note: "",
    });
  });

  it("claims what the target removes, from the target as the base had it", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "9-drop-auth-description");
    const workspacePath = join(root, "architecture", "workspace.json");
    const text = readFileSync(workspacePath, "utf8");
    // Drops the auth middleware's one relationship, to the identity provider.
    const workspace = JSON.parse(text);
    const auth = workspace.model.softwareSystems
      .flatMap((system: { containers?: Array<{ components?: unknown[] }> }) => system.containers ?? [])
      .flatMap((container: { components?: unknown[] }) => container.components ?? [])
      .find((component: { id: string }) => component.id === "7");
    const [relationship] = auth.relationships;
    auth.relationships = [];
    for (const view of workspace.views.dynamicViews) {
      view.relationships = view.relationships.filter((step: { id: string }) => step.id !== relationship.id);
    }
    writeFileSync(workspacePath, JSON.stringify(workspace));
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qam", "drop");

    const draft = await draftClaim(loadConfig(root), { branch: "9-drop-auth", base: await forkPoint(root) });
    expect(draft.model).toEqual({ added: [], removed: ["authMiddleware->identityProvider"] });
    expect(draft.issues).toEqual(["#9"]);
  });

  it("keeps the issues and note the agent confirmed", async () => {
    const root = basketRepo();
    git(root, "checkout", "-q", "-b", "issue-2-add-item");
    write(root, "src/basket-api/basket-service/addItem.ts", "export {};\n");
    const config = loadConfig(root);
    const base = await forkPoint(root);
    const previous = {
      branch: "issue-2-add-item",
      issues: ["#2", "#3"],
      model: { added: ["basketController->basketRepository"], removed: [] },
      files: [],
      note: "Adds items.",
    };
    expect(await draftClaim(config, { branch: "issue-2-add-item", base, previous })).toEqual({
      branch: "issue-2-add-item",
      issues: ["#2", "#3"],
      model: { added: [], removed: [] },
      files: [{ path: "src/basket-api/basket-service/addItem.ts", component: "basketService" }],
      note: "Adds items.",
    });
  });
});

describe("readClaim", () => {
  it("reads a branch's claims file, or nothing if it has none", async () => {
    const root = copyBasket("wrong-place");
    const config = loadConfig(root);
    expect(await readClaim(config, "wrong-place")).toMatchObject({ branch: "wrong-place" });
    expect(await readClaim(config, "feat/other")).toBeUndefined();
  });
});

describe("forkPoint", () => {
  it("is the merge base with main", async () => {
    const root = basketRepo();
    const main = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "-b", "topic");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "x");
    expect(await forkPoint(root)).toBe(main);
  });

  it("asks for --base when there's no main", async () => {
    const root = basketRepo();
    git(root, "branch", "-m", "trunk");
    await expect(forkPoint(root)).rejects.toThrow("can't find where this branch forked from main; pass --base");
    expect(await forkPoint(root, "trunk")).toBe(git(root, "rev-parse", "HEAD").trim());
  });
});
