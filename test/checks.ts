import type { CheckReport } from "../src/check.js";

// Every check skipped, for a test to fill in the ones it needs.
export function skipped(): CheckReport {
  const base = { status: "skipped" as const, blocking: true as const, reason: "not run" };
  return {
    passed: true,
    checks: [
      { ...base, check: "valid", model: "architecture/workspace.dsl", problems: [] },
      { ...base, check: "target", base: "main", proposed: [], moved: [] },
      { ...base, check: "claim", mismatches: [] },
      { ...base, check: "boundaries", undeclared: [], queues: [] },
      { ...base, check: "deployment", added: [], removed: [], drifted: [], unknown: [] },
      { ...base, check: "coverage", issues: [], criteria: [], recorded: 0 },
      { ...base, check: "paths", issues: [], views: [] },
      { check: "surplus", status: "skipped", blocking: false, outside: [], closed: [], untraced: [], traced: false },
    ],
  };
}
