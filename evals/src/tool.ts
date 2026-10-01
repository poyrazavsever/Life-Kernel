#!/usr/bin/env node
// The only way a model under test reaches Life Kernel: `node tool.js <sandbox> <tool> [-|json]`.
// It starts the real stdio server for the sandbox, makes one call, prints the reply, and records the call.
import { resolve } from "node:path";
import { connect } from "./client.js";

const [sandboxArg, tool, argsArg] = process.argv.slice(2);
if (!sandboxArg || !tool) {
  process.stderr.write("Usage: tool.js <sandbox> <tool> [-|json]\n");
  process.exit(2);
}
const dir = resolve(sandboxArg);
const sandbox = { dir, configPath: resolve(dir, "lifekernel.config.json") };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(raw: string): Record<string, unknown> | string {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch (error: unknown) {
    return `the arguments are not valid JSON (${error instanceof Error ? error.message : String(error)})`;
  }
}

const parsed = parseArgs(argsArg === "-" ? await readStdin() : argsArg ?? "");
if (typeof parsed === "string") {
  process.stdout.write(`ERROR: ${parsed}\n`);
  process.exit(1);
}

const connection = await connect(sandbox);
try {
  const { text, isError } = await connection.call(tool, parsed);
  process.stdout.write(`${isError ? "ERROR: " : ""}${text}\n`);
} catch (error: unknown) {
  process.stdout.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await connection.close();
}
