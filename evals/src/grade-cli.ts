#!/usr/bin/env node
// `node dist/grade-cli.js <sandbox> [--final file]`: grade one run and write result.json beside it.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gradeRun } from "./grade.js";
import { loadSandbox } from "./meta.js";
import { scenarioById } from "./scenarios/index.js";

const [dirArg, ...rest] = process.argv.slice(2);
if (!dirArg) {
  process.stderr.write("Usage: grade-cli.js <sandbox> [--final file]\n");
  process.exit(2);
}
const finalIndex = rest.indexOf("--final");
const sandbox = await loadSandbox(resolve(dirArg));
const finalText = finalIndex >= 0 ? await readFile(resolve(rest[finalIndex + 1]!), "utf8") : await readFile(join(sandbox.dir, "final.txt"), "utf8").catch(() => "");
const result = await gradeRun(sandbox, scenarioById(sandbox.scenarioId), finalText);
await writeFile(join(sandbox.dir, "result.json"), JSON.stringify(result, null, 2), "utf8");

const mark = (pass: boolean) => (pass ? "PASS" : "FAIL");
process.stdout.write(`${result.scenario}: outcome ${result.outcome.passed}/${result.outcome.total}, process ${result.process.passed}/${result.process.total}; ${result.metrics.toolCalls} tool calls, ${result.metrics.toolErrors} errors, ${result.metrics.writesApplied} writes\n`);
for (const check of result.checks) process.stdout.write(`  ${mark(check.pass)} [${check.kind}] ${check.description}${check.detail && !check.pass ? `  (${check.detail})` : ""}\n`);
