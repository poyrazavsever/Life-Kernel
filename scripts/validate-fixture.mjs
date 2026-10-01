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
  const init = run("init", "vaults/personal");
  if (!init.config.created) throw new Error(`init should create a config: ${JSON.stringify(init)}`);
  const generated = run("doctor");
  if (!generated.ok || !generated.checks[0].path.replaceAll("\\", "/").endsWith("vaults/personal")) throw new Error(`the generated config does not point at the vault: ${JSON.stringify(generated)}`);
  if (run("init", "vaults/personal").config.created) throw new Error("init must not overwrite an existing config");
  for (const template of ["startup", "work"]) {
    const added = run("init", `vaults/${template}`, "--template", template);
    if (added.config.added !== template) throw new Error(`init --template ${template} should add the vault: ${JSON.stringify(added)}`);
    const broken = await brokenLinks(join(work, "vaults", template));
    if (broken.length) throw new Error(`broken wikilinks in the ${template} template: ${broken.join("; ")}`);
  }
  const all = run("validate");
  if (!all.ok) throw new Error(`templates fail validation: ${JSON.stringify(all.issues)}`);
  if (run("vaults").map((vault) => vault.id).join(",") !== "personal,startup,work") throw new Error("init should register every template vault");
  await writeFile(join(work, "lifekernel.config.json"), JSON.stringify({
    version: 1, stateDir: "./state", timezone: "UTC",
    vaults: [{ id: "personal", kind: "personal", path: "./vaults/personal", mode: "read-write", routes: {} }]
  }));
  const doctor = run("doctor");
  const validation = run("validate");
  if (!doctor.ok) throw new Error(`doctor failed: ${JSON.stringify(doctor)}`);
  if (!validation.ok || validation.notes === 0) throw new Error(`validate failed: ${JSON.stringify(validation)}`);
  const migration = run("migrate", "personal");
  if (migration.from !== migration.to || migration.changes.length) throw new Error(`a fresh vault should need no migration: ${JSON.stringify(migration)}`);
  const quiet = run("tick", "--dry-run");
  if (quiet.enabled !== false) throw new Error(`tick should be off without a notifications section: ${JSON.stringify(quiet)}`);
  const plan = run("schedule", "install", "--dry-run", "--config", join(work, "lifekernel.config.json"));
  if (!plan.dryRun || plan.files.length === 0 || !plan.files.some((file) => /(^|[\s"'>])tick([\s"'<]|$)/m.test(file.content))) throw new Error(`schedule dry run looks wrong: ${JSON.stringify(plan)}`);
  const calendar = execFileSync(process.execPath, [cli, "ics", "personal"], { cwd: work, encoding: "utf8", env: { ...process.env, INIT_CWD: work, LIFEKERNEL_CONFIG: join(work, "lifekernel.config.json") } });
  if (!calendar.startsWith("BEGIN:VCALENDAR") || calendar.includes("BEGIN:VEVENT")) throw new Error("a fresh vault's calendar should be empty");
  const today = run("today", "--json");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today.date) || today.focus !== null) throw new Error(`today looks wrong for a fresh vault: ${JSON.stringify(today)}`);
  try {
    run("brief", "morning-plan");
    throw new Error("brief must refuse while briefs are off");
  } catch (error) {
    if (!String(error.stderr ?? error.message).includes("Briefs are off")) throw error;
  }
  const insights = run("insights", "week", "--json");
  if (insights.period.kind !== "week" || insights.days.recorded !== 0 || insights.observations.length !== 0) throw new Error(`a fresh vault should have empty insights: ${JSON.stringify(insights)}`);
  const broken = await brokenLinks(join(work, "vaults/personal"));
  if (broken.length) throw new Error(`broken wikilinks: ${broken.join("; ")}`);
  process.stdout.write(`fixture ok: ${validation.notes} notes validated\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
