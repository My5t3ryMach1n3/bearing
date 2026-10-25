import { cpSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const basketDir = join(import.meta.dirname, "fixtures", "basket");

// The seeded broken branches, each an overlay on the clean repo. See test/fixtures/basket/README.md.
export const basketVariants = [
  "controller-imports-repository",
  "redis-node",
  "untraced-helper",
  "wrong-place",
] as const;
export type BasketVariant = (typeof basketVariants)[number];

// Copies the basket repo to a temp directory, with a variant's files laid over it, and returns the copy's root.
// The copy borrows Bearing's node_modules, so its own scripts run without an install.
export function copyBasket(variant?: BasketVariant): string {
  const root = mkdtempSync(join(tmpdir(), `bearing-basket-${variant ?? "main"}-`));
  cpSync(join(basketDir, "repo"), root, { recursive: true });
  if (variant !== undefined) cpSync(join(basketDir, "variants", variant), root, { recursive: true });
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(root, "node_modules"), "junction");
  return root;
}
