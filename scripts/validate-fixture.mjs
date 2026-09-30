// Clean-install check: init the starter vault in a temp dir, then run doctor and validate through the built CLI.
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/index.js");
const work = await mkdtemp(join(tmpdir(), "lifekernel-fixture-"));

const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
  cwd: work, encoding: "utf8", env: { ...process.env, INIT_CWD: work, LIFEKERNEL_CONFIG: join(work, "lifekernel.config.json") }
}));

try {
  run("init", "vaults/personal");
  await writeFile(join(work, "lifekernel.config.json"), JSON.stringify({
    version: 1, stateDir: "./state", timezone: "UTC",
    vaults: [{ id: "personal", kind: "personal", path: "./vaults/personal", mode: "read-write", routes: {} }]
  }));
  const doctor = run("doctor");
  const validation = run("validate");
  if (!doctor.ok) throw new Error(`doctor failed: ${JSON.stringify(doctor)}`);
  if (!validation.ok || validation.notes === 0) throw new Error(`validate failed: ${JSON.stringify(validation)}`);
  process.stdout.write(`fixture ok: ${validation.notes} notes validated\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
