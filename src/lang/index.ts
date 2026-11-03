import type { Config, Language, LanguageConfig } from "../config.js";
import { within } from "../paths.js";
import type { LanguageAdapter } from "./adapter.js";
import { typescript } from "./typescript.js";

// Every language Bearing has an adapter for. A new adapter is added here and to `languageNames` in config.ts.
export const adapters: Record<Language, LanguageAdapter> = { typescript };

// The configured language a repo-relative file belongs to: the one with the deepest root holding it whose adapter
// reads files like it. Undefined for files no language reads, such as Terraform or docs.
export function languageOf(config: Pick<Config, "languages">, file: string): LanguageConfig | undefined {
  return config.languages
    .filter((language) => within(file, language.root) && adapters[language.name].sourceFile.test(file))
    .sort((a, b) => depth(b.root) - depth(a.root))[0];
}

// The adapters of the configured languages, each once.
export function configuredAdapters(config: Pick<Config, "languages">): LanguageAdapter[] {
  return [...new Set(config.languages.map((language) => adapters[language.name]))];
}

// Where tests write their criterion tag, across every configured language, e.g. "in its name".
export function tagWhere(config: Pick<Config, "languages">): string {
  return [...new Set(configuredAdapters(config).map((adapter) => adapter.tagCarrier.where))].join(" or ");
}

function depth(root: string): number {
  return root === "." ? 0 : root.split("/").length;
}
