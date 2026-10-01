#!/usr/bin/env node
// `node dist/prepare.js <scenario> [--name run-name]`: build a sandbox and the prompt for a model under test.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "./client.js";
import { writeSandboxMeta } from "./meta.js";
import { buildPrompt } from "./prompt.js";
import { createSandbox } from "./sandbox.js";
import { scenarioById, scenarios } from "./scenarios/index.js";

const [id, ...rest] = process.argv.slice(2);
if (!id) {
  process.stderr.write(`Usage: prepare.js <scenario> [--name run-name]\nScenarios: ${scenarios.map((scenario) => scenario.id).join(", ")}\n`);
  process.exit(2);
}
const nameIndex = rest.indexOf("--name");
const scenario = scenarioById(id);
const sandbox = await createSandbox(scenario, nameIndex >= 0 ? { name: rest[nameIndex + 1]! } : {});
await writeSandboxMeta(sandbox);
const connection = await connect(sandbox, { record: false });
try {
  const promptPath = join(sandbox.dir, "prompt.md");
  await writeFile(promptPath, buildPrompt(scenario, sandbox, connection), "utf8");
  process.stdout.write(`${JSON.stringify({ scenario: scenario.id, sandbox: sandbox.dir, prompt: promptPath, today: sandbox.today }, null, 2)}\n`);
} finally {
  await connection.close();
}
