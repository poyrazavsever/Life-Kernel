import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root; evals/src and evals/dist are both two levels below it. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const stdioServer = join(repoRoot, "apps/mcp/dist/stdio.js");
export const toolCli = join(repoRoot, "evals/dist/tool.js");
export const runsDir = join(repoRoot, "evals/runs");
