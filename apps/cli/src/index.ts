#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, formatToday, LifeKernel, loadConfig, loadEnvBeside, notificationsVault, pauseNudges, pollTelegram, RITUAL_IDS, sendTestNotification, skipRitual, snoozeRitual, telegramChats, tick, todaySummary, type RitualId } from "@lifekernel/core";
import { CLIENTS, connectSnippet, isClient } from "./connect.js";
import { manageSchedule, schedulePlan } from "./schedule.js";

const argv = process.argv.slice(2);
// `--config <path>` lets the OS scheduler run the CLI from any directory.
const configFlag = argv.indexOf("--config");
const explicitConfig = configFlag >= 0 ? argv.splice(configFlag, 2)[1] : undefined;
const [command, ...args] = argv;
const invocationRoot = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : process.cwd();
const configPath = explicitConfig ? resolve(invocationRoot, explicitConfig) : process.env.LIFEKERNEL_CONFIG ?? resolve(invocationRoot, "lifekernel.config.json");
const here = dirname(fileURLToPath(import.meta.url));

function output(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main() {
  if (command === "init") {
    const template = flag("--template") ?? "personal";
    if (!isTemplate(template)) throw new Error(`Unknown template ${template}. Use ${TEMPLATES.join(", ")}.`);
    const id = flag("--id") ?? template;
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(id)) throw new Error("--id must use lowercase letters, digits, - and _.");
    const target = resolve(invocationRoot, positional()[0] ?? `vaults/${template}`);
    await mkdir(target, { recursive: true });
    await cp(resolve(here, "../../../templates", template === "personal" ? "starter-vault" : `${template}-vault`), target, { recursive: true, errorOnExist: false, force: false });
    output({ ok: true, target, template, config: await registerVault(target, template, id) });
    return;
  }
  if (command === "connect") {
    if (!isClient(args[0])) throw new Error(`Usage: lifekernel connect <${CLIENTS.join("|")}>`);
    const stdioPath = resolve(here, "../../mcp/dist/stdio.js");
    const { file, content } = connectSnippet(args[0], stdioPath, resolve(configPath));
    process.stdout.write(`# ${file}
${content}
`);
    return;
  }
  await loadEnvBeside(configPath);
  const kernel = new LifeKernel(await loadConfig(configPath));
  if (command === "doctor") return output(await kernel.doctor());
  if (command === "validate") return output(await kernel.validate(args[0]));
  if (command === "vaults") return output(kernel.listVaults());
  if (command === "search") return output(await kernel.search(args.join(" ")));
  if (command === "read") return output(await kernel.readNote(args[0] ?? "", args[1] ?? ""));
  if (command === "list") return output(await kernel.listNotes(args[0] ?? "", { ...(args[1] ? { type: args[1] } : {}), ...(args[2] ? { status: args[2] } : {}) }));
  if (command === "tasks") return output(await kernel.openTasks(args[0] ? { vaultId: args[0] } : {}));
  if (command === "rituals") return output(await kernel.ritualStatus(args[0] ?? ""));
  if (command === "agenda") return output(await kernel.ritualAgenda(args[0] ?? "", args[1] as never, args[2] ? { date: args[2] } : {}));
  if (command === "migrate") {
    if (!args[0]) throw new Error("Usage: lifekernel migrate <vaultId> [--apply]");
    const starterDir = resolve(here, "../../../templates/starter-vault");
    return output(await kernel.migrate(args[0], { apply: args.includes("--apply"), starterDir }));
  }
  if (command === "tick") {
    // Locally there is no long-running listener, so each check also reads Telegram replies.
    const telegram = args.includes("--dry-run") ? null : await pollTelegram(kernel).catch((error: Error) => ({ error: error.message }));
    return output({ ...await tick(kernel, { dryRun: args.includes("--dry-run") }), ...(telegram && !("enabled" in telegram && !telegram.enabled) ? { telegram } : {}) });
  }
  if (command === "capture") return output(await capture(kernel, notificationsVault(kernel), args.join(" "), { source: "cli", context: { client: { name: "lifekernel-cli" } } }));
  if (command === "today") {
    const vaultArg = args.find((arg) => !arg.startsWith("--"));
    const summary = await todaySummary(kernel, vaultArg ?? notificationsVault(kernel));
    if (args.includes("--json")) return output(summary);
    process.stdout.write(`${formatToday(summary, kernel.config.notifications?.locale ?? "en")}\n`);
    return;
  }
  if (command === "telegram") {
    if (args[0] === "setup") return output({ chats: await telegramChats(kernel), next: "Put your chat's id in LIFEKERNEL_TELEGRAM_CHAT_ID in the .env beside the config." });
    if (args[0] === "poll") return output(await pollTelegram(kernel));
    throw new Error("Usage: lifekernel telegram <setup|poll>");
  }
  if (command === "notify") {
    if (args[0] !== "test") throw new Error("Usage: lifekernel notify test [channel index]");
    return output(await sendTestNotification(kernel, args[1] === undefined ? {} : { index: Number(args[1]) }));
  }
  if (command === "snooze") return output(await snoozeRitual(kernel, ritualArg(args[0]), minutes(args[1] ?? "60m")));
  if (command === "skip") return output(await skipRitual(kernel, notificationsVault(kernel), ritualArg(args[0]), args.slice(1).join(" "), { client: { name: "lifekernel-cli" } }));
  if (command === "pause") return output(await pauseNudges(kernel, args[0] ?? ""));
  if (command === "resume") return output(await pauseNudges(kernel, null));
  if (command === "ics") { process.stdout.write(await kernel.ritualCalendar(args[0] ?? notificationsVault(kernel))); return; }
  if (command === "schedule") {
    const action = args[0];
    if (action !== "install" && action !== "uninstall" && action !== "status") throw new Error("Usage: lifekernel schedule <install|uninstall|status> [--every 5] [--dry-run]");
    const every = args.indexOf("--every");
    const plan = schedulePlan(process.platform, {
      node: process.execPath, cli: fileURLToPath(import.meta.url), config: resolve(configPath), stateDir: kernel.config.stateDir, home: homedir(),
      ...(process.getuid ? { uid: process.getuid() } : {})
    }, every >= 0 ? Number(args[every + 1]) : 5);
    return output(await manageSchedule(action, plan, args.includes("--dry-run")));
  }
  if (command === "preview" || command === "apply") {
    const request = JSON.parse(await readFile(resolve(invocationRoot, args[0] ?? ""), "utf8"));
    return output(command === "preview" ? await kernel.previewWrite(request) : await kernel.applyWrite(request, { client: { name: "lifekernel-cli" } }));
  }
  process.stderr.write("Usage: lifekernel <init|connect|doctor|validate|vaults|search|read|list|tasks|rituals|agenda|preview|apply|migrate|tick|notify|snooze|skip|pause|resume|ics|schedule|capture|today|telegram> [...args] [--config path]\n");
  process.exitCode = 1;
}

const TEMPLATES = ["personal", "startup", "work"] as const;
type Template = (typeof TEMPLATES)[number];
const isTemplate = (value: string): value is Template => (TEMPLATES as readonly string[]).includes(value);

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Arguments that are neither flags nor flag values. */
function positional(): string[] {
  return args.filter((arg, index) => !arg.startsWith("--") && !(index > 0 && args[index - 1]!.startsWith("--") && ["--template", "--id", "--every", "--config"].includes(args[index - 1]!)));
}

type ConfigFile = { timezone?: string; vaults: Array<{ id: string; kind: string; path: string; mode: string; routes: Record<string, unknown> }> } & Record<string, unknown>;

/**
 * Add the new vault to the config, or write a config if none exists (from the example for a personal
 * vault). An existing vault with the same ID or path is left alone. Returns what happened.
 */
async function registerVault(vault: string, template: Template, id: string) {
  const path = resolve(configPath);
  const example = JSON.parse(await readFile(resolve(here, "../../../lifekernel.config.example.json"), "utf8")) as ConfigFile;
  const routes = template === "personal" ? example.vaults[0]!.routes : JSON.parse(await readFile(resolve(vault, ".lifekernel", "routes.json"), "utf8")) as Record<string, unknown>;
  const entry = { id, kind: template, path: `./${relative(dirname(path), vault).replaceAll("\\", "/")}`, mode: "read-write", routes };
  let existing: ConfigFile | null = null;
  try { existing = JSON.parse(await readFile(path, "utf8")) as ConfigFile; } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!existing) {
    const fresh = template === "personal" ? { ...example, vaults: [entry] } : { version: 1, stateDir: "./.lifekernel-data", vaults: [entry] };
    await writeFile(path, `${JSON.stringify({ ...fresh, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { path, created: true, added: id };
  }
  const samePath = existing.vaults.find((candidate) => resolve(dirname(path), candidate.path) === resolve(vault));
  if (samePath || existing.vaults.some((candidate) => candidate.id === id)) return { path, created: false, added: null, existing: samePath?.id ?? id };
  existing.vaults.push(entry);
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return { path, created: false, added: id };
}

function ritualArg(value: string | undefined): RitualId {
  if (!value || !(RITUAL_IDS as readonly string[]).includes(value)) throw new Error(`Name a ritual: ${RITUAL_IDS.join(", ")}.`);
  return value as RitualId;
}

/** "45", "45m", "2h" in minutes. */
function minutes(value: string): number {
  const match = /^(\d+)\s*(m|min|h)?$/.exec(value.trim());
  if (!match) throw new Error("Give a duration such as 30m or 2h.");
  return Number(match[1]) * (match[2] === "h" ? 60 : 1);
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

