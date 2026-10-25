import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { basketDir, basketVariants, copyBasket } from "./basket.js";

const repo = join(basketDir, "repo");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

interface Issue {
  number: number;
  body: string;
}
const issues = JSON.parse(readFileSync(join(basketDir, "issues.json"), "utf8")) as Issue[];

// Every `#<issue>/AC<n>` the issues define, from their numbered criteria.
const criteria = issues.flatMap(({ number, body }) =>
  [...body.matchAll(/^(\d+)\. Given /gm)].map((match) => `#${number}/AC${match[1]}`),
);

describe("basket fixture", () => {
  it("loads its config", () => {
    expect(loadConfig(repo)).toMatchObject({
      root: repo,
      model: "architecture/workspace.dsl",
      languages: ["typescript"],
    });
  });

  it("has a folder for every component path in its model", () => {
    const paths = [...read("architecture/workspace.dsl").matchAll(/"bearing\.path" "([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(paths).toHaveLength(5);
    for (const path of paths) expect(statSync(join(repo, path!)).isDirectory()).toBe(true);
  });

  it("has a dynamic view for every requirement", () => {
    const views = [...read("architecture/workspace.dsl").matchAll(/dynamic basketApi "req-(\d+)"/g)].map((match) =>
      Number(match[1]),
    );
    expect(views).toEqual(issues.map((issue) => issue.number));
  });

  it("tags an integration test with every acceptance criterion, and nothing else", () => {
    const dir = join(repo, "test", "integration");
    const tags = readdirSync(dir).flatMap((file) =>
      [...readFileSync(join(dir, file), "utf8").matchAll(/it\("(#\d+\/AC\d+) /g)].map((match) => match[1]),
    );
    expect(tags.sort()).toEqual(criteria.sort());
  });

  // Each run copies the repo, typechecks it and runs its integration tests through the config's own command.
  it.each(["main", ...basketVariants] as const)(
    "%s typechecks and passes its tests",
    { timeout: 60_000 },
    (variant) => {
      const root = copyBasket(variant === "main" ? undefined : variant);
      const [command, ...args] = loadConfig(root).tests.integration!.split(" ");
      execFileSync("npm", ["run", "--silent", "typecheck"], { cwd: root, stdio: "pipe" });
      execFileSync(command!, args, { cwd: root, stdio: "pipe" });
    },
  );
});
