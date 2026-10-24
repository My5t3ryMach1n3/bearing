import { readFileSync } from "node:fs";

// package.json sits one level above both src/ and dist/.
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const version = packageJson.version;
