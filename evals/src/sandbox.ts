import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { LifeKernel, loadConfig, localDate } from "@lifekernel/core";
import { repoRoot, runsDir } from "./paths.js";
import type { Baseline, Sandbox, Scenario } from "./types.js";

export const TIMEZONE = "Europe/Istanbul";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export async function markdownHashes(vaultDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".md")) out[relative(vaultDir, full).replaceAll("\\", "/")] = sha256(await readFile(full, "utf8"));
    }
  };
  await walk(vaultDir);
  return out;
}

export async function auditLines(stateDir: string): Promise<number> {
  try { return (await readFile(join(stateDir, "audit.jsonl"), "utf8")).split("\n").filter(Boolean).length; } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * A throwaway personal vault from the starter template with the example config's routes, seeded for a scenario.
 * Nothing here touches a real vault. `baseline.json` records what the seed left behind, so grading can tell the
 * model's changes from the starting state.
 */
export async function createSandbox(scenario: Scenario, options: { baseDir?: string; name?: string } = {}): Promise<Sandbox> {
  const dir = join(options.baseDir ?? runsDir, options.name ?? `${scenario.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const vaultDir = join(dir, "personal");
  const stateDir = join(dir, "state");
  await mkdir(dir, { recursive: true });
  await cp(join(repoRoot, "templates/starter-vault"), vaultDir, { recursive: true });
  const config = JSON.parse(await readFile(join(repoRoot, "lifekernel.config.example.json"), "utf8")) as { timezone: string; stateDir: string; vaults: Array<{ path: string }> };
  config.timezone = TIMEZONE;
  config.stateDir = "./state";
  config.vaults[0]!.path = "./personal";
  const configPath = join(dir, "lifekernel.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const today = localDate(TIMEZONE);
  const kernel = new LifeKernel(await loadConfig(configPath));
  let seeded = 0;
  await scenario.seed?.({
    kernel, vaultDir, today,
    write: (request) => kernel.applyWrite({ requestId: `seed-auto-${String(++seeded).padStart(5, "0")}`, vaultId: "personal", source: "seed", sourceDate: today, title: "Seed", approved: true, ...request })
  });

  const baseline: Baseline = { files: await markdownHashes(vaultDir), auditOffset: await auditLines(stateDir) };
  await writeFile(join(dir, "baseline.json"), JSON.stringify(baseline, null, 2), "utf8");
  return { dir, vaultDir, stateDir, configPath, today, scenarioId: scenario.id };
}
