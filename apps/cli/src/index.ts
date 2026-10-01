#!/usr/bin/env node
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LifeKernel, loadConfig } from "@lifekernel/core";
import { CLIENTS, connectSnippet, isClient } from "./connect.js";

const [command, ...args] = process.argv.slice(2);
const invocationRoot = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : process.cwd();
const configPath = process.env.LIFEKERNEL_CONFIG ?? resolve(invocationRoot, "lifekernel.config.json");

function output(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main() {
  if (command === "init") {
    const target = resolve(invocationRoot, args[0] ?? "vaults/personal");
    const here = dirname(fileURLToPath(import.meta.url));
    const template = resolve(here, "../../../templates/starter-vault");
    await mkdir(target, { recursive: true });
    await cp(template, target, { recursive: true, errorOnExist: false, force: false });
    output({ ok: true, target });
    return;
  }
  if (command === "connect") {
    if (!isClient(args[0])) throw new Error(`Usage: lifekernel connect <${CLIENTS.join("|")}>`);
    const here = dirname(fileURLToPath(import.meta.url));
    const stdioPath = resolve(here, "../../mcp/dist/stdio.js");
    const { file, content } = connectSnippet(args[0], stdioPath, resolve(configPath));
    process.stdout.write(`# ${file}
${content}
`);
    return;
  }
  const kernel = new LifeKernel(await loadConfig(configPath));
  if (command === "doctor") return output(await kernel.doctor());
  if (command === "validate") return output(await kernel.validate(args[0]));
  if (command === "vaults") return output(kernel.listVaults());
  if (command === "search") return output(await kernel.search(args.join(" ")));
  if (command === "read") return output(await kernel.readNote(args[0] ?? "", args[1] ?? ""));
  if (command === "preview" || command === "apply") {
    const request = JSON.parse(await readFile(resolve(invocationRoot, args[0] ?? ""), "utf8"));
    return output(command === "preview" ? await kernel.previewWrite(request) : await kernel.applyWrite(request, { client: { name: "lifekernel-cli" } }));
  }
  process.stderr.write("Usage: lifekernel <init|connect|doctor|validate|vaults|search|read|preview|apply> [...args]\n");
  process.exitCode = 1;
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

