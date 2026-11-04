import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./basket.js";

export const bookingDir = join(import.meta.dirname, "fixtures", "booking");

// The seeded branches, each an overlay on the clean repo. See test/fixtures/booking/README.md.
export const bookingVariants = [
  "routes-read-repository",
  "slot-check-in-route",
  "slot-labels",
  "untraced-helper",
] as const;
export type BookingVariant = (typeof bookingVariants)[number];

// The interpreter the booking API's tests run with: one that has pytest, FastAPI and httpx. CI's has them.
export const testPython = process.env.BEARING_TEST_PYTHON || "python3";

// Whether there's a Python to test the Python adapter with: Bearing reads code with python3, or BEARING_PYTHON, and
// the fixture's tests need their packages.
export const hasPython = (() => {
  try {
    execFileSync(
      process.env.BEARING_PYTHON || "python3",
      ["-c", "import sys; sys.version_info >= (3, 11) or __import__('tomli')"],
      { stdio: "ignore" },
    );
    execFileSync(testPython, ["-c", "import pytest, fastapi, httpx"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// The fixture's test command, with the interpreter that has its packages.
export const pytestCommand = `${testPython} -m pytest -q -p no:cacheprovider`;

// Copies the booking API to a temp directory, with a variant's files laid over it, reading its target from the
// exported workspace JSON so no test runs Structurizr. Returns the copy's root.
export function copyBooking(variant?: BookingVariant): string {
  const root = mkdtempSync(join(tmpdir(), `bearing-booking-${variant ?? "main"}-`));
  cpSync(join(bookingDir, "repo"), root, { recursive: true });
  if (variant !== undefined) cpSync(join(bookingDir, "variants", variant), root, { recursive: true });
  cpSync(join(bookingDir, "workspace.json"), join(root, "architecture", "workspace.json"));
  const config = join(root, ".bearing", "config.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8")
      .replace("workspace.dsl", "workspace.json")
      .replace("python3 -m pytest -q", pytestCommand),
  );
  return root;
}

// The booking API as a git repo with main committed and, given a variant, the variant committed on a branch of its
// name.
export function bookingRepo(variant?: BookingVariant): string {
  const root = copyBooking();
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "main");
  if (variant !== undefined) {
    git(root, "checkout", "-q", "-b", variant);
    cpSync(join(bookingDir, "variants", variant), root, { recursive: true });
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", variant);
  }
  return root;
}
