// Clean-install check: init the starter vault in a temp dir, then run doctor and validate through the built CLI.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/index.js");
const work = await mkdtemp(join(tmpdir(), "lifekernel-fixture-"));

const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
  cwd: work, encoding: "utf8", env: { ...process.env, INIT_CWD: work, LIFEKERNEL_CONFIG: join(work, "lifekernel.config.json") }
}));

async function markdown(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await markdown(full, base));
    else if (entry.name.endsWith(".md")) out.push(full.slice(base.length + 1).replaceAll("\\", "/"));
  }
  return out;
}

async function brokenLinks(vault) {
  const files = await markdown(vault);
  const known = new Set(files.map((f) => f.replace(/\.md$/, "")));
  const broken = [];
  for (const file of files) {
    const text = await readFile(join(vault, file), "utf8");
    for (const [, target] of text.matchAll(/\[\[([^\]|#]+)/g)) {
      if (!target.includes("{{") && !known.has(target.trim())) broken.push(`${file} -> ${target}`);
    }
  }
  return broken;
}

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
  const broken = await brokenLinks(join(work, "vaults/personal"));
  if (broken.length) throw new Error(`broken wikilinks: ${broken.join("; ")}`);
  process.stdout.write(`fixture ok: ${validation.notes} notes validated\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
