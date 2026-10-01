import { readFileSync } from "node:fs";

// Resolves from both src/ (tests) and dist/ (builds): each sits one level below the package root.
export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
