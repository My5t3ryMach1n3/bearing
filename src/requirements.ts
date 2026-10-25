import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";
import { githubRepository, githubToken, runCommand } from "./github.js";
import type { Run } from "./structurizr.js";

// A requirement is a GitHub issue labelled `requirements.label`; its number is the stable ID.
// See the Requirements input section of docs/product-spec.md.
export interface Requirement {
  // "#4"
  id: string;
  number: number;
  title: string;
  state: "open" | "closed";
  // Why it was closed, as GitHub says it: "completed", "not_planned" or "duplicate". Null while open.
  stateReason: string | null;
  story: string;
  criteria: Criterion[];
  // The epic this story sits under, if any.
  parent: number | null;
  // Has sub-issues. Epics group stories and get no dynamic view of their own.
  epic: boolean;
}

export interface Criterion {
  // "#4/AC2"
  id: string;
  number: number;
  text: string;
}

// An issue shaped like GitHub's REST API returns it, which is also the format of a fixture file.
// `parent` isn't a REST field: it's the parent issue's number, which REST only gives as a URL.
export interface IssueRecord {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: Array<{ name: string }>;
  body: string | null;
  parent?: number | null;
  sub_issues_summary?: { total: number };
}

export class RequirementsError extends Error {
  constructor(readonly problems: string[]) {
    super(`requirements:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "RequirementsError";
  }
}

export interface LoadRequirementsOptions {
  // A JSON array of IssueRecord to read instead of GitHub. Defaults to $BEARING_ISSUES_FILE.
  issuesFile?: string;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  fetch?: typeof fetch;
}

// Loads every requirement, open and closed, sorted by number. Throws a RequirementsError listing every open issue
// whose body doesn't parse; closed issues are returned as far as they parse, since nothing is built from them.
export async function loadRequirements(config: Config, options: LoadRequirementsOptions = {}): Promise<Requirement[]> {
  const { env = process.env } = options;
  const issuesFile = options.issuesFile ?? (env.BEARING_ISSUES_FILE || undefined);
  const label = config.requirements.label;
  const issues =
    issuesFile === undefined
      ? await fetchIssues(config, label, options)
      : (JSON.parse(await readFile(issuesFile, "utf8")) as IssueRecord[]).filter((issue) =>
          issue.labels.some((each) => each.name === label),
        );
  const problems: string[] = [];
  const requirements = issues
    .map((issue) => {
      const parsed = parseIssue(issue);
      if (issue.state === "open") problems.push(...parsed.problems);
      return parsed.requirement;
    })
    .sort((a, b) => a.number - b.number);
  if (problems.length > 0) throw new RequirementsError(problems);
  return requirements;
}

// The open stories that each need exactly one dynamic view: everything open except epics.
export function leafStories(requirements: Requirement[]): Requirement[] {
  return requirements.filter((requirement) => requirement.state === "open" && !requirement.epic);
}

// A section heading as the issue form writes it (`### Story`) or as people write it by hand (`**Story**`).
const heading = /^\s*(?:#{1,6}\s+(.+?)\s*#*|\*\*(.+?):?\*\*:?)\s*$/;
const numbered = /^\s*(\d+)[.)]\s+(.*)$/;
const givenWhenThen = /^given\b.*\bwhen\b.*\bthen\b/is;
// What an issue form writes for a field left empty.
const noResponse = "_No response_";

export function parseIssue(issue: IssueRecord): { requirement: Requirement; problems: string[] } {
  const id = `#${issue.number}`;
  const epic = (issue.sub_issues_summary?.total ?? 0) > 0;
  const sections = splitSections(issue.body ?? "");
  const problems: string[] = [];

  const story = sections.get("story") ?? "";
  if (story === "" && !epic) problems.push(`${id}: no Story; add a "**Story**" section with the user story`);

  const criteria: Criterion[] = [];
  const text = sections.get("acceptance criteria") ?? "";
  let unnumbered = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = numbered.exec(line);
    if (match !== null) {
      criteria.push({ id: `${id}/AC${match[1]}`, number: Number(match[1]), text: match[2]!.trim() });
    } else if (criteria.length > 0) {
      // A criterion wrapped onto the next line.
      const last = criteria.at(-1)!;
      last.text = `${last.text} ${line.trim()}`;
    } else {
      problems.push(`${id}: acceptance criteria must be a numbered list; found "${line.trim()}"`);
      unnumbered = true;
      break;
    }
  }
  if (criteria.length === 0 && !epic && !unnumbered) {
    problems.push(`${id}: no acceptance criteria; add an "**Acceptance criteria**" section with a numbered list`);
  }
  criteria.forEach((criterion, index) => {
    if (criterion.number !== index + 1) {
      problems.push(
        `${criterion.id}: criteria must be numbered 1, 2, 3... in order; expected ${index + 1}, so tests and readers agree on each number`,
      );
    }
    if (!givenWhenThen.test(criterion.text)) {
      problems.push(`${criterion.id}: not in Given/When/Then form: "${criterion.text}"`);
    }
  });

  return {
    requirement: {
      id,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      stateReason: issue.state_reason ?? null,
      story,
      criteria,
      parent: issue.parent ?? null,
      epic,
    },
    problems,
  };
}

// Splits a body into sections by heading, keyed by lower-cased heading. Text before the first heading is dropped.
function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  const lines: string[] = [];
  const flush = () => {
    if (current === undefined) return;
    const text = lines.join("\n").trim();
    sections.set(current, text === noResponse ? "" : text);
  };
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const match = heading.exec(line);
    if (match !== null) {
      flush();
      current = (match[1] ?? match[2]!).trim().replace(/:$/, "").toLowerCase();
      lines.length = 0;
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

// GitHub's REST issue list doesn't say which issues are sub-issues, so this reads them through GraphQL.
const issuesQuery = `query($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(labels: [$label], states: [OPEN, CLOSED], first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { number title state stateReason body parent { number } subIssues { totalCount } }
    }
  }
}`;

interface IssuesPage {
  data?: {
    repository: {
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          number: number;
          title: string;
          state: "OPEN" | "CLOSED";
          stateReason: string | null;
          body: string;
          parent: { number: number } | null;
          subIssues: { totalCount: number };
        }>;
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

async function fetchIssues(config: Config, label: string, options: LoadRequirementsOptions): Promise<IssueRecord[]> {
  const { env = process.env, run = runCommand, fetch: fetchFn = fetch } = options;
  const [owner, name] = (await repository(config, env, run)).split("/");
  const bearer = await token(env, run);
  const url = env.GITHUB_GRAPHQL_URL || "https://api.github.com/graphql";
  const issues: IssueRecord[] = [];
  let after: string | null = null;
  do {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { authorization: `bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ query: issuesQuery, variables: { owner, name, label, after } }),
    });
    if (!response.ok) {
      throw new RequirementsError([`GitHub returned ${response.status} ${response.statusText} reading issues`]);
    }
    const page = (await response.json()) as IssuesPage;
    if (page.errors !== undefined) throw new RequirementsError(page.errors.map((error) => `GitHub: ${error.message}`));
    const found = page.data?.repository?.issues;
    if (found === undefined) throw new RequirementsError([`GitHub repository ${owner}/${name} not found`]);
    for (const node of found.nodes) {
      issues.push({
        number: node.number,
        title: node.title,
        state: node.state === "OPEN" ? "open" : "closed",
        state_reason: node.state === "OPEN" ? null : (node.stateReason?.toLowerCase() ?? null),
        labels: [{ name: label }],
        body: node.body,
        parent: node.parent?.number ?? null,
        sub_issues_summary: { total: node.subIssues.totalCount },
      });
    }
    after = found.pageInfo.hasNextPage ? found.pageInfo.endCursor : null;
  } while (after !== null);
  return issues;
}

async function repository(config: Config, env: NodeJS.ProcessEnv, run: Run): Promise<string> {
  const found = await githubRepository(config.root, env, run);
  if (found === undefined) {
    throw new RequirementsError([
      "can't tell which GitHub repository holds the requirements; set GITHUB_REPOSITORY=owner/name, or add a GitHub origin remote",
    ]);
  }
  return found;
}

async function token(env: NodeJS.ProcessEnv, run: Run): Promise<string> {
  const found = await githubToken(env, run);
  if (found === undefined) {
    throw new RequirementsError([
      "no GitHub token to read requirements with; set GITHUB_TOKEN, or install the GitHub CLI and run `gh auth login`",
    ]);
  }
  return found;
}
