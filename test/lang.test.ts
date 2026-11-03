import { describe, expect, it } from "vitest";
import { adapters, configuredAdapters, languageOf, tagWhere } from "../src/lang/index.js";

const config = {
  languages: [
    { name: "typescript" as const, root: ".", project: "tsconfig.json" },
    { name: "typescript" as const, root: "services/api", project: "tsconfig.json" },
  ],
};

describe("languageOf", () => {
  it("gives a file to the language with the deepest root holding it", () => {
    expect(languageOf(config, "services/api/src/index.ts")).toBe(config.languages[1]);
    expect(languageOf(config, "services/apiary/index.ts")).toBe(config.languages[0]);
    expect(languageOf(config, "src/index.mjs")).toBe(config.languages[0]);
  });

  it("gives no language to files no adapter reads", () => {
    expect(languageOf(config, "infra/main.tf")).toBeUndefined();
    expect(languageOf({ languages: [config.languages[1]!] }, "src/index.ts")).toBeUndefined();
  });
});

describe("configuredAdapters", () => {
  it("lists each configured language's adapter once", () => {
    expect(configuredAdapters(config)).toEqual([adapters.typescript]);
    expect(tagWhere(config)).toBe("in its name");
  });
});
