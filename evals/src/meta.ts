import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sandbox } from "./types.js";

export async function writeSandboxMeta(sandbox: Sandbox): Promise<void> {
  await writeFile(join(sandbox.dir, "sandbox.json"), JSON.stringify({ today: sandbox.today, scenarioId: sandbox.scenarioId }, null, 2), "utf8");
}

export async function loadSandbox(dir: string): Promise<Sandbox> {
  const meta = JSON.parse(await readFile(join(dir, "sandbox.json"), "utf8")) as Pick<Sandbox, "today" | "scenarioId">;
  return { dir, vaultDir: join(dir, "personal"), stateDir: join(dir, "state"), configPath: join(dir, "lifekernel.config.json"), ...meta };
}
