import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "../src/config.js";
import { leafStories, loadRequirements, parseIssue, RequirementsError, type IssueRecord } from "../src/requirements.js";
import type { Run } from "../src/structurizr.js";
import { basketDir } from "./basket.js";

const config = parseConfig("version: 1\nmodel: architecture/workspace.dsl\nlanguage: typescript\n", "/repo");
const basketIssues = join(basketDir, "issues.json");

function issue(body: string, fields: Partial<IssueRecord> = {}): IssueRecord {
  return { number: 4, title: "Restore the basket", state: "open", labels: [{ name: "requirement" }], body, ...fields };
}

const problems = (body: string, fields?: Partial<IssueRecord>) => parseIssue(issue(body, fields)).problems;

const spec = `**Story**
As a shopper, I want my basket restored after my session expires, so that I don't lose it.

**Acceptance criteria**
1. Given an expired session, when they return and sign in, then their saved basket is restored.
2. Given an expired session, when the shopper changes their basket, then the request is rejected.
`;

function writeIssues(issues: IssueRecord[]): string {
  const file = join(mkdtempSync(join(tmpdir(), "bearing-issues-")), "issues.json");
  writeFileSync(file, JSON.stringify(issues));
  return file;
}

describe("parseIssue", () => {
  it("reads the story and numbered criteria as #<n>/AC<k>", () => {
    expect(parseIssue(issue(spec))).toEqual({
      requirement: {
        id: "#4",
        number: 4,
        title: "Restore the basket",
        state: "open",
        stateReason: null,
        story: "As a shopper, I want my basket restored after my session expires, so that I don't lose it.",
        criteria: [
          {
            id: "#4/AC1",
            number: 1,
            text: "Given an expired session, when they return and sign in, then their saved basket is restored.",
          },
          {
            id: "#4/AC2",
            number: 2,
            text: "Given an expired session, when the shopper changes their basket, then the request is rejected.",
          },
        ],
        parent: null,
        epic: false,
      },
      problems: [],
    });
  });

  it("reads a body written by the requirement issue form the same as one written by hand", () => {
    // An issue form writes each field as a `### <label>` heading followed by what was typed in it.
    const form = parseYaml(
      readFileSync(new URL("../templates/init/.github/ISSUE_TEMPLATE/requirement.yml", import.meta.url), "utf8"),
    ) as { body: Array<{ type: string; attributes: { label?: string; placeholder?: string } }> };
    const body = form.body
      .filter((field) => field.type === "textarea")
      .map((field) => `### ${field.attributes.label}\n\n${field.attributes.placeholder!.trim()}`)
      .join("\n\n");
    const fromForm = parseIssue(issue(body));
    expect(fromForm.problems).toEqual([]);
    expect(fromForm.requirement.story).toMatch(/^As a shopper/);
    expect(fromForm.requirement.criteria.map((criterion) => criterion.id)).toEqual(["#4/AC1", "#4/AC2"]);
  });

  it("joins a criterion wrapped over several lines, and accepts 1) numbering and CRLF", () => {
    const body =
      "**Story:**\r\nAs a shopper...\r\n\r\n## Acceptance criteria\r\n1) Given a basket,\r\n   when it empties,\r\n   then it is empty.\r\n";
    const { requirement, problems } = parseIssue(issue(body));
    expect(problems).toEqual([]);
    expect(requirement.criteria).toEqual([
      { id: "#4/AC1", number: 1, text: "Given a basket, when it empties, then it is empty." },
    ]);
  });

  it("rejects a story with no story or criteria", () => {
    expect(problems("Just restore it please")).toEqual([
      '#4: no Story; add a "**Story**" section with the user story',
      '#4: no acceptance criteria; add an "**Acceptance criteria**" section with a numbered list',
    ]);
  });

  it("treats an issue form's empty field as missing", () => {
    expect(problems("### Story\n\n_No response_\n\n### Acceptance criteria\n\n1. Given a, when b, then c.")).toEqual([
      '#4: no Story; add a "**Story**" section with the user story',
    ]);
  });

  it("rejects criteria that aren't a numbered list", () => {
    expect(problems("**Story**\nAs a shopper...\n\n**Acceptance criteria**\n- Given a, when b, then c.")).toEqual([
      '#4: acceptance criteria must be a numbered list; found "- Given a, when b, then c."',
    ]);
  });

  it("rejects criteria numbered out of order, since GitHub renders them renumbered", () => {
    const body =
      "**Story**\nAs a shopper...\n\n**Acceptance criteria**\n1. Given a, when b, then c.\n3. Given d, when e, then f.";
    expect(problems(body)).toEqual([
      "#4/AC3: criteria must be numbered 1, 2, 3... in order; expected 2, so tests and readers agree on each number",
    ]);
  });

  it("rejects a criterion that isn't Given/When/Then", () => {
    const body =
      "**Story**\nAs a shopper...\n\n**Acceptance criteria**\n1. The basket is restored.\n2. Then given a, when b.";
    expect(problems(body)).toEqual([
      '#4/AC1: not in Given/When/Then form: "The basket is restored."',
      '#4/AC2: not in Given/When/Then form: "Then given a, when b."',
    ]);
  });

  it("lets an epic go without story or criteria", () => {
    const { requirement, problems } = parseIssue(
      issue("Groups the basket stories.", { sub_issues_summary: { total: 3 } }),
    );
    expect(problems).toEqual([]);
    expect(requirement.epic).toBe(true);
  });
});

describe("loadRequirements", () => {
  it("reads the basket fixture's six requirements from fixture mode", async () => {
    const requirements = await loadRequirements(config, { env: { BEARING_ISSUES_FILE: basketIssues } });
    expect(requirements.map((requirement) => requirement.id)).toEqual(["#1", "#2", "#3", "#4", "#6", "#7"]);
    expect(requirements.flatMap((requirement) => requirement.criteria.map((criterion) => criterion.id))).toEqual([
      ...["#1/AC1", "#1/AC2", "#2/AC1", "#2/AC2", "#3/AC1", "#3/AC2"],
      ...["#4/AC1", "#4/AC2", "#6/AC1", "#6/AC2", "#7/AC1"],
    ]);
  });

  it("keeps only issues with the configured label", async () => {
    const issuesFile = writeIssues([issue(spec), issue("A bug", { number: 5, labels: [{ name: "bug" }] })]);
    expect((await loadRequirements(config, { issuesFile })).map((requirement) => requirement.number)).toEqual([4]);
  });

  it("lists every malformed open issue, and returns closed ones as far as they parse", async () => {
    const issuesFile = writeIssues([
      issue("no criteria", { number: 8 }),
      issue("no criteria either", { number: 9, state: "closed", state_reason: "not_planned" }),
      issue("**Story**\nAs a...", { number: 10 }),
    ]);
    const error = await loadRequirements(config, { issuesFile }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequirementsError);
    expect((error as RequirementsError).problems.map((problem) => problem.split(":")[0])).toEqual(["#8", "#8", "#10"]);

    const closedOnly = writeIssues([issue("no criteria", { state: "closed", state_reason: "not_planned" })]);
    expect(await loadRequirements(config, { issuesFile: closedOnly })).toMatchObject([
      { id: "#4", state: "closed", stateReason: "not_planned", criteria: [] },
    ]);
  });
});

describe("leafStories", () => {
  it("returns open stories, not epics or closed issues", async () => {
    const issuesFile = writeIssues([
      issue("Basket epic", { number: 1, sub_issues_summary: { total: 2 } }),
      issue(spec, { number: 2, parent: 1 }),
      issue(spec, { number: 3, parent: 1, state: "closed", state_reason: "completed" }),
      issue(spec, { number: 4 }),
    ]);
    const requirements = await loadRequirements(config, { issuesFile });
    expect(leafStories(requirements).map((requirement) => [requirement.id, requirement.parent])).toEqual([
      ["#2", 1],
      ["#4", null],
    ]);
  });
});

describe("reading from GitHub", () => {
  // A fake GitHub GraphQL endpoint serving `pages` in order, recording each request.
  function fakeGitHub(pages: object[]) {
    const requests: Array<{ url: string; authorization: string; variables: Record<string, unknown> }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const { variables } = JSON.parse(init.body as string) as { variables: Record<string, unknown> };
      requests.push({ url, authorization: (init.headers as Record<string, string>).authorization!, variables });
      return new Response(JSON.stringify(pages[requests.length - 1]), { status: 200 });
    }) as typeof globalThis.fetch;
    return { fetch, requests };
  }

  const node = (number: number, fields: object = {}) => ({
    number,
    title: `Story ${number}`,
    state: "OPEN",
    stateReason: null,
    body: spec,
    parent: null,
    subIssues: { totalCount: 0 },
    ...fields,
  });
  const page = (nodes: object[], endCursor: string | null = null) => ({
    data: { repository: { issues: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } } },
  });

  it("uses the CI token and repository, and follows pages", async () => {
    const github = fakeGitHub([
      page([node(1, { subIssues: { totalCount: 1 } })], "cursor-1"),
      page([node(2, { parent: { number: 1 } }), node(3, { state: "CLOSED", stateReason: "NOT_PLANNED" })]),
    ]);
    const env = { GITHUB_TOKEN: "ci-token", GITHUB_REPOSITORY: "acme/basket" };
    const requirements = await loadRequirements(config, { env, fetch: github.fetch });
    expect(github.requests.map((request) => [request.url, request.authorization, request.variables])).toEqual([
      [
        "https://api.github.com/graphql",
        "bearer ci-token",
        { owner: "acme", name: "basket", label: "requirement", after: null },
      ],
      [
        "https://api.github.com/graphql",
        "bearer ci-token",
        { owner: "acme", name: "basket", label: "requirement", after: "cursor-1" },
      ],
    ]);
    expect(
      requirements.map(({ id, epic, parent, state, stateReason }) => ({ id, epic, parent, state, stateReason })),
    ).toEqual([
      { id: "#1", epic: true, parent: null, state: "open", stateReason: null },
      { id: "#2", epic: false, parent: 1, state: "open", stateReason: null },
      { id: "#3", epic: false, parent: null, state: "closed", stateReason: "not_planned" },
    ]);
  });

  it("falls back to gh's token and the origin remote locally", async () => {
    const calls: string[][] = [];
    const run: Run = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "gh") return { code: 0, output: "gh-token\n" };
      return { code: 0, output: "git@github.com:acme/basket.git\n" };
    };
    const github = fakeGitHub([page([node(1)])]);
    await loadRequirements(config, { env: {}, run, fetch: github.fetch });
    expect(calls).toEqual([
      ["git", "-C", "/repo", "remote", "get-url", "origin"],
      ["gh", "auth", "token"],
    ]);
    expect(github.requests[0]).toMatchObject({
      authorization: "bearer gh-token",
      variables: { owner: "acme", name: "basket" },
    });
  });

  it("says how to authenticate when there's no token and no gh", async () => {
    const run: Run = async (command) => {
      if (command === "gh") throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      return { code: 0, output: "https://github.com/acme/basket\n" };
    };
    await expect(loadRequirements(config, { env: {}, run })).rejects.toThrow(
      "no GitHub token to read requirements with; set GITHUB_TOKEN, or install the GitHub CLI and run `gh auth login`",
    );
  });

  it("says which repository it needs when origin isn't on GitHub", async () => {
    const run: Run = async () => ({ code: 0, output: "https://gitlab.com/acme/basket.git\n" });
    await expect(loadRequirements(config, { env: { GITHUB_TOKEN: "t" }, run })).rejects.toThrow(
      "set GITHUB_REPOSITORY=owner/name, or add a GitHub origin remote",
    );
  });

  it("reports GitHub's errors", async () => {
    const github = fakeGitHub([{ errors: [{ message: "Bad credentials" }] }]);
    const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/basket" };
    await expect(loadRequirements(config, { env, fetch: github.fetch })).rejects.toThrow("GitHub: Bad credentials");
  });
});
