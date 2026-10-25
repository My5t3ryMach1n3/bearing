import { configDefaults, defineConfig } from "vitest/config";

// The basket fixture has its own tests, which test/basket.test.ts runs inside a copy of the fixture.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "test/fixtures/**"] } });
