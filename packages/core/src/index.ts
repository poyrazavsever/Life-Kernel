import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { detectEol, frontmatterBlock, frontmatterEnd, readFrontmatter, setFrontmatter, type FieldValue } from "./frontmatter.js";
import { PERIODS, periodKey, periodRange, type Period } from "./periods.js";
import { buildAgenda } from "./agenda.js";
import { replaceFile, withFileLock } from "./files.js";
import { ritualCalendar } from "./ics.js";
import { NotificationsSchema } from "./nudges.js";
import { evaluateRituals, parseQuietHours, RITUAL_FIELDS, RITUAL_IDS, type Outcome, type QuietHours, type RitualId, type RitualStatus } from "./rituals.js";
import { replaceSection } from "./sections.js";
import { parseTasks, PRIORITY_RANK, type Task } from "./tasks.js";
import { isoInZone } from "./time.js";

export { periodKey, periodRange, PERIODS, type Period } from "./periods.js";
export { parseTasks, type Task, type TaskPriority, type TaskStatus } from "./tasks.js";
export { readFrontmatter, setFrontmatter, type FieldValue } from "./frontmatter.js";
export { readSection, replaceSection } from "./sections.js";
export { RITUAL_FIELDS, RITUAL_IDS, type QuietHours, type RitualId, type RitualState, type RitualStatus } from "./rituals.js";
export { ChannelSchema, createChannel, desktopCommand, type Channel, type ChannelConfig, type ChannelDeps, type NudgeMessage } from "./channels.js";
export { decideNudges, loadNudgeState, notificationsVault, NotificationsSchema, nudgeMessage, pauseNudges, sendTestNotification, skipRitual, snoozeRitual, tick, type NotificationsConfig, type NudgeState, type TickResult } from "./nudges.js";

/** Keys no route may change: identity, provenance, and access. Lowering ai_access stays a human action. */
export const PROTECTED_FIELDS = ["id", "type", "created", "updated", "source", "source_date", "privacy", "ai_access"] as const;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const RouteSchema = z.object({
  folder: z.string().min(1),
  type: z.string().min(1),
  status: z.string().min(1),
  area: z.string().min(1),
  moc: z.string().optional(),
  policy: z.enum(["auto", "review", "deny"]).default("review"),
  /** One note per period, named by its period key. Routes of type `daily` default to `day`. */
  period: z.enum(PERIODS).optional(),
  /** Frontmatter keys that `create` and `set_frontmatter` may set on this route (default none). */
  fields: z.array(z.string().regex(FIELD_NAME).refine((key) => !(PROTECTED_FIELDS as readonly string[]).includes(key), (key) => ({ message: `${key} is a protected field and cannot be writable.` }))).optional()
});

export type RoutePolicy = z.infer<typeof RouteSchema>["policy"];
export type RouteConfig = z.infer<typeof RouteSchema>;

const VaultSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/),
  kind: z.enum(["personal", "project", "research"]),
  path: z.string().min(1),
  mode: z.enum(["read-only", "read-write"]),
  routes: z.record(RouteSchema).default({}),
  bundle: z.array(z.string().min(1)).optional(),
  /** The note whose frontmatter holds the planning method and ritual schedule (default `system/Method.md`). */
  methodNote: z.string().min(1).optional(),
  /** Folders that search, listing, and task queries skip (default `_templates`). Validation still checks them. */
  ignore: z.array(z.string().min(1)).optional()
});

function isValidTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: value }); return true; } catch { return false; }
}

const ConfigSchema = z.object({
  version: z.literal(1),
  stateDir: z.string().default("./.lifekernel-data"),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA time zone.").default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  vaults: z.array(VaultSchema).min(1),
  /** Ritual reminders; absent means none are sent. */
  notifications: NotificationsSchema.optional()
});

function FieldValueSchema() {
  const text = z.string().max(500).refine((value) => !/[\r\n]/.test(value), "Frontmatter values must be a single line.");
  const scalar = z.union([text, z.number().finite()]);
  return z.union([scalar, z.boolean(), z.null(), z.array(scalar).max(50)]);
}

export const WriteRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, "requestId must be 8-128 characters: letters, digits, dot, underscore, or hyphen."),
  vaultId: z.string().min(1),
  operation: z.enum(["create", "append", "update_section", "set_frontmatter"]),
  route: z.string().min(1),
  /** Required for create; ignored by the other operations. */
  title: z.string().min(1).max(180).optional(),
  /** Required for create, append, and update_section; not accepted for set_frontmatter. */
  body: z.string().min(1).optional(),
  /** Frontmatter to set on create or set_frontmatter; null removes a key. Keys must be in the route's `fields`. */
  fields: z.record(z.string().regex(FIELD_NAME), FieldValueSchema()).optional(),
  targetPath: z.string().optional(),
  section: z.string().trim().min(1).max(180).optional(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  source: z.string().min(1),
  sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  approved: z.boolean().optional()
});

export type LifeKernelConfig = z.infer<typeof ConfigSchema>;
export type VaultConfig = z.infer<typeof VaultSchema>;
export type WriteRequest = z.infer<typeof WriteRequestSchema>;

export interface SearchHit {
  vaultId: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  sha256: string;
}

export interface PreviewResult {
  requestId: string;
  vaultId: string;
  path: string;
  operation: WriteRequest["operation"];
  policy: RoutePolicy;
  beforeSha256: string | null;
  afterSha256: string;
  changedBytes: number;
  preview: string;
}
export type ApplyResult = PreviewResult & { appliedAt: string; replayed: boolean };

/** Who asked for a write. `id` comes from authentication; `name` is what the client calls itself. */
export interface WriteContext { client?: { id?: string; name?: string } }

export interface KernelOptions {
  /** Clock used for dates and timestamps; tests pass a fixed one. */
  now?: () => Date;
}

interface Receipt { fingerprint: string; state?: "pending" | "applied"; result: PreviewResult & { appliedAt?: string } }

/** Starter vault layout this release writes and migrates to. */
export const LAYOUT_VERSION = 3;
const DAILY_TEMPLATE_FIELDS: Record<string, FieldValue> = { energy: "", focus_hours: "", morning_plan: "", circle: "", circle_at: "" };


function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableNoteId(vaultId: string, requestId: string): string {
  const bytes = Buffer.from(sha256(`${vaultId}:${requestId}`).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function localDate(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export const DEFAULT_BUNDLE = [
  "AGENTS.md",
  "system/AI Context.md",
  "system/Method.md",
  "state/Current State.md",
  "profile/Profile.md",
  "schedule/Capacity.md",
  "schedule/Near-Term Plan.md"
];

export interface BundleNote { path: string; sha256: string; truncated: boolean; content: string }
export interface ContextBundle {
  vaultId: string;
  date: string;
  notes: BundleNote[];
  skipped: Array<{ path: string; reason: "missing" | "excluded" | "restricted" | "budget" }>;
  totalChars: number;
  /** Ritual state right now; present when the bundle is for today. */
  rituals?: RitualReport;
}

export interface RitualReport {
  vaultId: string;
  /** The current time in the configured zone. */
  now: string;
  date: string;
  timeZone: string;
  quietHours: QuietHours | null;
  rituals: RitualStatus[];
  /** Set when the method note cannot be read, so no ritual is scheduled. */
  error?: string;
}

export interface Backlink { path: string; line: number; excerpt: string; sha256: string }

// Letters that NFKD does not decompose into an ASCII base letter.
const TRANSLITERATIONS: Record<string, string> = { "\u0131": "i", "\u00df": "ss", "\u00e6": "ae", "\u00f8": "o", "\u0153": "oe", "\u0111": "d", "\u0142": "l", "\u00fe": "th" };

function slugify(value: string, fallback: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const ascii = normalized.replace(/[\u0131\u00df\u00e6\u00f8\u0153\u0111\u0142\u00fe]/g, (letter) => TRANSLITERATIONS[letter]!);
  const slug = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function yamlValue(value: string): string {
  return JSON.stringify(value);
}

type AiAccess = "context" | "restricted" | "none";
const AI_ACCESS = ["context", "restricted", "none"];

/** A note's ai_access. An unrecognized value counts as restricted, so a typo never widens access. */
function aiAccessFor(content: string): AiAccess | null {
  const data = readFrontmatter(content);
  if (data) {
    const value = data.ai_access;
    if (value === undefined || value === null || value === "") return null;
    return AI_ACCESS.includes(String(value)) ? value as AiAccess : "restricted";
  }
  // Frontmatter that is not valid YAML still honors a recognizable ai_access line.
  const match = frontmatterBlock(content).match(/^ai_access:\s*["']?([A-Za-z]+)["']?\s*(?:#.*)?$/m);
  if (!match) return null;
  return AI_ACCESS.includes(match[1]!) ? match[1] as AiAccess : "restricted";
}

/** Fold case and accents for matching, so "istanbul" finds "İstanbul" and "calisma" finds "Çalışma". */
function fold(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ı/g, "i");
}

function noteTitle(content: string, path: string): string {
  return content.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1] ?? basename(path, extname(path));
}

/** The period of a route, if it keeps one note per period. Older configs mark daily notes only by type. */
function routePeriod(route: RouteConfig): Period | undefined {
  return route.period ?? (route.type === "daily" ? "day" : undefined);
}

function assertReadable(content: string, includeRestricted: boolean): void {
  const access = aiAccessFor(content);
  if (access === "none") throw new Error("This note is excluded from AI access.");
  if (access === "restricted" && !includeRestricted) throw new Error("This note requires explicit restricted access.");
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

async function readReceipt(path: string): Promise<Receipt | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as Receipt; } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}


function bumpUpdated(content: string, today: string): string {
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  for (let index = 1; index < end - 1; index += 1) {
    if (/^updated:/.test(lines[index]!)) {
      lines[index] = `updated: ${yamlValue(today)}`;
      return lines.join(detectEol(content));
    }
  }
  return content;
}


export function resolveMarkdownPath(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("Absolute note paths are not allowed.");
  const candidate = resolve(root, relativePath);
  if (!isInside(root, candidate)) throw new Error("Path escapes the configured vault root.");
  if (extname(candidate).toLowerCase() !== ".md") throw new Error("Only Markdown notes are allowed.");
  return candidate;
}

async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(full);
    }
  };
  await walk(root);
  return output;
}

/**
 * Read `KEY=value` lines from a `.env` file beside the config into `process.env`, without overriding
 * variables that are already set. Scheduled tasks start without the user's shell, so secrets such as
 * the ntfy topic reach them this way. Returns the keys it set.
 */
export async function loadEnvBeside(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  let text: string;
  try { text = await readFile(join(dirname(resolve(configPath)), ".env"), "utf8"); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

export async function loadConfig(configPath: string): Promise<LifeKernelConfig> {
  const absoluteConfig = resolve(configPath);
  const text = await readFile(absoluteConfig, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`No config at ${absoluteConfig}. Run "npm run cli -- init" to create one, copy lifekernel.config.example.json to lifekernel.config.json, or point LIFEKERNEL_CONFIG or --config at your config.`);
  });
  const raw = JSON.parse(text) as unknown;
  const parsed = ConfigSchema.parse(raw);
  const base = dirname(absoluteConfig);
  return {
    ...parsed,
    stateDir: resolve(base, parsed.stateDir),
    vaults: parsed.vaults.map((vault) => ({
      ...vault,
      path: resolve(base, vault.path)
    }))
  };
}

export class LifeKernel {
  private readonly now: () => Date;

  constructor(public readonly config: LifeKernelConfig, options: KernelOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private today(): string {
    return localDate(this.config.timezone, this.now());
  }

  private vault(id: string): VaultConfig {
    const vault = this.config.vaults.find((candidate) => candidate.id === id);
    if (!vault) throw new Error(`Unknown vault: ${id}`);
    return vault;
  }

  listVaults() {
    return this.config.vaults.map(({ id, kind, mode, routes }) => ({
      id, kind, mode,
      routes: Object.entries(routes).map(([name, route]) => ({ name, folder: route.folder, type: route.type, policy: route.policy, ...(routePeriod(route) ? { period: routePeriod(route) } : {}), fields: route.fields ?? [] }))
    }));
  }

  async doctor() {
    const checks = [];
    for (const vault of this.config.vaults) {
      let ok = false;
      try { ok = (await stat(vault.path)).isDirectory(); } catch { ok = false; }
      checks.push({ vaultId: vault.id, path: vault.path, mode: vault.mode, ok });
    }
    return { ok: checks.every((item) => item.ok), checks, stateDir: this.config.stateDir };
  }

  async readNote(vaultId: string, path: string, includeRestricted = false) {
    const vault = this.vault(vaultId);
    const absolute = resolveMarkdownPath(vault.path, path);
    const content = await readFile(absolute, "utf8");
    assertReadable(content, includeRestricted);
    return { vaultId, path: relative(vault.path, absolute).replaceAll("\\", "/"), content, sha256: sha256(content) };
  }

  /** Markdown notes in a vault, minus its ignored folders, with vault-relative paths. */
  private async notes(vault: VaultConfig): Promise<Array<{ file: string; path: string }>> {
    const ignored = (vault.ignore ?? ["_templates"]).map((folder) => `${folder.replace(/^\/+|\/+$/g, "")}/`);
    return (await markdownFiles(vault.path))
      .map((file) => ({ file, path: relative(vault.path, file).replaceAll("\\", "/") }))
      .filter(({ path }) => !ignored.some((prefix) => path.startsWith(prefix)));
  }

  /**
   * Find lines in notes that contain every search term somewhere in the note, in any order.
   * Matching ignores case and accents. `type` and `status` filter by frontmatter.
   */
  async search(query: string, vaultId?: string, limit = 20, includeRestricted = false, filter: { type?: string; status?: string } = {}): Promise<SearchHit[]> {
    const terms = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
    if (terms.length === 0) throw new Error("Search query cannot be empty.");
    const vaults = vaultId ? [this.vault(vaultId)] : this.config.vaults;
    const hits: SearchHit[] = [];
    for (const vault of vaults) {
      for (const { file, path } of await this.notes(vault)) {
        const content = await readFile(file, "utf8");
        const access = aiAccessFor(content);
        if (access === "none" || (access === "restricted" && !includeRestricted)) continue;
        if (filter.type || filter.status) {
          const data = readFrontmatter(content) ?? {};
          if ((filter.type && data.type !== filter.type) || (filter.status && data.status !== filter.status)) continue;
        }
        const folded = fold(content);
        if (!terms.every((term) => folded.includes(term))) continue;
        const lines = content.split(/\r?\n/);
        const hash = sha256(content);
        lines.forEach((line, index) => {
          if (hits.length >= limit) return;
          const foldedLine = fold(line);
          if (!terms.some((term) => foldedLine.includes(term))) return;
          const start = Math.max(0, index - 1);
          const end = Math.min(lines.length, index + 2);
          hits.push({ vaultId: vault.id, path, lineStart: start + 1, lineEnd: end, excerpt: lines.slice(start, end).join("\n"), sha256: hash });
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  /**
   * Look up the single note for the period containing a date (default: today in the configured time zone)
   * on a route that keeps one note per period. Pass `route`, or `period` when only one route has it.
   */
  async periodNote(vaultId: string, options: { route?: string; period?: Period; date?: string } = {}) {
    const vault = this.vault(vaultId);
    const date = options.date ?? this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD.");
    const candidates = Object.entries(vault.routes).filter(([name, route]) => routePeriod(route) && (!options.route || name === options.route) && (!options.period || routePeriod(route) === options.period));
    const described = options.period === "day" ? "daily" : options.period ? `${options.period}ly` : "periodic";
    if (candidates.length === 0) throw new Error(`Vault ${vault.id} has no ${described} route${options.route ? ` named ${options.route}` : ""}.`);
    if (candidates.length > 1) throw new Error(`Several ${described} routes exist; pass route.`);
    const [name, route] = candidates[0]!;
    const period = routePeriod(route)!;
    const key = periodKey(period, date);
    const base = { vaultId: vault.id, date, route: name, policy: route.policy, period, key, ...periodRange(period, date), path: `${route.folder}/${key}.md` };
    try {
      const note = await this.readNote(vault.id, base.path);
      return { ...base, exists: true as const, path: note.path, content: note.content, sha256: note.sha256 };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...base, exists: false as const };
    }
  }

  /** Look up the single daily note for a date (default: today in the configured time zone). */
  async dailyNote(vaultId: string, date?: string, routeName?: string) {
    return this.periodNote(vaultId, { period: "day", ...(date ? { date } : {}), ...(routeName ? { route: routeName } : {}) });
  }

  /**
   * Where each ritual stands right now: not scheduled, upcoming, due, overdue, done, or skipped, with the
   * streak and recently missed days. The schedule comes from the method note's frontmatter; completion
   * comes from the daily note's `morning_plan` and `circle` fields and the review notes' `status`.
   */
  async ritualStatus(vaultId: string, options: { at?: Date } = {}): Promise<RitualReport> {
    const vault = this.vault(vaultId);
    const now = options.at ?? this.now();
    const timeZone = this.config.timezone;
    const today = localDate(timeZone, now);
    const report: RitualReport = { vaultId: vault.id, now: isoInZone(now, timeZone), date: today, timeZone, quietHours: null, rituals: [] };
    let method: Record<string, unknown>;
    try {
      method = readFrontmatter((await this.readNote(vault.id, vault.methodNote ?? "system/Method.md")).content) ?? {};
    } catch (error: unknown) {
      report.rituals = RITUAL_IDS.map((id) => ({ id, state: "not-scheduled" as const }));
      report.error = `Method note unavailable: ${error instanceof Error ? error.message : String(error)}`;
      return report;
    }
    try { report.quietHours = parseQuietHours(method.quiet_hours); } catch (error: unknown) {
      report.error = error instanceof Error ? error.message : String(error);
    }

    const outcome = (value: unknown): Outcome => value === "done" || value === "skipped" ? value : null;
    const dailyCache = new Map<string, Record<string, unknown> | null>();
    const dailyRoute = Object.values(vault.routes).find((route) => routePeriod(route) === "day");
    let firstActiveDate: string | null = null;
    if (dailyRoute) {
      const names = await readdir(resolve(vault.path, dailyRoute.folder)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; });
      firstActiveDate = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).map((name) => name.slice(0, 10)).sort()[0] ?? null;
    }
    report.rituals = await evaluateRituals(method, {
      now, timeZone, today, firstActiveDate,
      dailyOutcome: async (date, field) => {
        if (!dailyCache.has(date)) {
          // A note the agent may not read counts as not done; its fields are never exposed.
          const found = await this.dailyNote(vault.id, date).catch(() => null);
          dailyCache.set(date, found?.exists ? readFrontmatter(found.content) : null);
        }
        return outcome(dailyCache.get(date)?.[field]);
      },
      periodOutcome: async (period, date) => {
        const found = await this.periodNote(vault.id, { period, date });
        if (!found.exists) return null;
        const status = readFrontmatter(found.content)?.status;
        return status === "complete" ? "done" : status === "skipped" ? "skipped" : null;
      }
    });
    return report;
  }

  /** The ritual schedule as an iCalendar feed: names and times only, never note content. */
  async ritualCalendar(vaultId: string): Promise<string> {
    const vault = this.vault(vaultId);
    const method = readFrontmatter((await this.readNote(vault.id, vault.methodNote ?? "system/Method.md")).content) ?? {};
    const now = this.now();
    return ritualCalendar(method, { timeZone: this.config.timezone, vaultId: vault.id, today: localDate(this.config.timezone, now), now, locale: this.config.notifications?.locale ?? "en" });
  }

  /** What a ritual should cover on a date (default today), with sources. Reads only notes the agent may read. */
  async ritualAgenda(vaultId: string, ritual: RitualId, options: { date?: string } = {}) {
    const vault = this.vault(vaultId);
    if (!(RITUAL_IDS as readonly string[]).includes(ritual)) throw new Error(`Unknown ritual: ${ritual}. Known: ${RITUAL_IDS.join(", ")}.`);
    const date = options.date ?? this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD.");
    return buildAgenda(this, vault.id, ritual, date);
  }

  /** List notes by frontmatter. Notes without the filtered value are left out. */
  async listNotes(vaultId: string, filter: { type?: string; status?: string; area?: string; folder?: string; updatedBefore?: string; updatedAfter?: string; includeRestricted?: boolean; limit?: number } = {}) {
    const vault = this.vault(vaultId);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const folder = filter.folder ? `${filter.folder.replace(/^\/+|\/+$/g, "")}/` : undefined;
    const notes: Array<{ path: string; title: string; frontmatter: Record<string, unknown>; sha256: string }> = [];
    for (const { file, path } of await this.notes(vault)) {
      if (folder && !path.startsWith(folder)) continue;
      const content = await readFile(file, "utf8");
      const access = aiAccessFor(content);
      if (access === "none" || (access === "restricted" && !filter.includeRestricted)) continue;
      const data = readFrontmatter(content) ?? {};
      if (filter.type && data.type !== filter.type) continue;
      if (filter.status && data.status !== filter.status) continue;
      if (filter.area && data.area !== filter.area) continue;
      const updated = typeof data.updated === "string" ? data.updated : "";
      if (filter.updatedBefore && !(updated && updated < filter.updatedBefore)) continue;
      if (filter.updatedAfter && !(updated && updated > filter.updatedAfter)) continue;
      notes.push({ path, title: noteTitle(content, path), frontmatter: data, sha256: sha256(content) });
      if (notes.length >= limit) break;
    }
    return notes;
  }

  /**
   * Open checklist items in Obsidian Tasks format, ordered by due date, then priority.
   * `dueBy` keeps tasks due on or before a date; undated tasks are kept unless `includeUndated` is false.
   */
  async openTasks(filter: { vaultId?: string; path?: string; type?: string; area?: string; dueBy?: string; includeUndated?: boolean; includeRestricted?: boolean; limit?: number } = {}) {
    if (filter.path && !filter.vaultId) throw new Error("path requires vaultId.");
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const vaults = filter.vaultId ? [this.vault(filter.vaultId)] : this.config.vaults;
    const found: Array<Task & { vaultId: string; path: string; sha256: string }> = [];
    for (const vault of vaults) {
      const files = filter.path
        ? [{ file: resolveMarkdownPath(vault.path, filter.path), path: relative(vault.path, resolveMarkdownPath(vault.path, filter.path)).replaceAll("\\", "/") }]
        : await this.notes(vault);
      for (const { file, path } of files) {
        const content = await readFile(file, "utf8");
        const access = aiAccessFor(content);
        if (access === "none" || (access === "restricted" && !filter.includeRestricted)) {
          if (filter.path) assertReadable(content, filter.includeRestricted ?? false);
          continue;
        }
        if (filter.type || filter.area) {
          const data = readFrontmatter(content) ?? {};
          if ((filter.type && data.type !== filter.type) || (filter.area && data.area !== filter.area)) continue;
        }
        const hash = sha256(content);
        for (const task of parseTasks(content)) {
          if (task.status === "done" || task.status === "cancelled") continue;
          if (filter.dueBy && (task.due ? task.due > filter.dueBy : filter.includeUndated === false)) continue;
          if (!filter.dueBy && filter.includeUndated === false && !task.due) continue;
          found.push({ vaultId: vault.id, path, sha256: hash, ...task });
        }
      }
    }
    found.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999")
      || PRIORITY_RANK[a.priority ?? "none"] - PRIORITY_RANK[b.priority ?? "none"]
      || a.path.localeCompare(b.path) || a.line - b.line);
    return found.slice(0, limit);
  }

  /**
   * Assemble the minimum context for a session: the vault's bundle notes, today's daily note,
   * and the most recent earlier daily notes, within a character budget.
   * Each entry carries the hash of the full note so a later write can cite it.
   */
  async contextBundle(vaultId: string, options: { date?: string; includeRestricted?: boolean; maxChars?: number; recentDaily?: number } = {}): Promise<ContextBundle> {
    const vault = this.vault(vaultId);
    const date = options.date ?? this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD.");
    const includeRestricted = options.includeRestricted ?? false;
    let remaining = Math.min(Math.max(options.maxChars ?? 24000, 1000), 200000);
    const paths = [...(vault.bundle ?? DEFAULT_BUNDLE)];

    const dailyRoute = Object.values(vault.routes).find((route) => routePeriod(route) === "day");
    if (dailyRoute) {
      let names: string[] = [];
      try { names = await readdir(resolve(vault.path, dailyRoute.folder)); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const earlier = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).map((name) => name.slice(0, 10)).filter((day) => day < date).sort().reverse();
      const recent = [date, ...earlier.slice(0, Math.max(0, Math.min(options.recentDaily ?? 3, 14)))];
      for (const day of recent) paths.push(`${dailyRoute.folder}/${day}.md`);
    }

    const notes: BundleNote[] = [];
    const skipped: ContextBundle["skipped"] = [];
    let totalChars = 0;
    for (const path of [...new Set(paths)]) {
      if (remaining <= 0) { skipped.push({ path, reason: "budget" }); continue; }
      try {
        const note = await this.readNote(vault.id, path, includeRestricted);
        const truncated = note.content.length > remaining;
        const content = truncated ? note.content.slice(0, remaining) : note.content;
        remaining -= content.length;
        totalChars += content.length;
        notes.push({ path: note.path, sha256: note.sha256, truncated, content });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") skipped.push({ path, reason: "missing" });
        else if (error instanceof Error && /excluded from AI access/.test(error.message)) skipped.push({ path, reason: "excluded" });
        else if (error instanceof Error && /restricted access/.test(error.message)) skipped.push({ path, reason: "restricted" });
        else throw error;
      }
    }
    const bundle: ContextBundle = { vaultId: vault.id, date, notes, skipped, totalChars };
    if (date === this.today()) bundle.rituals = await this.ritualStatus(vault.id);
    return bundle;
  }

  /** Find notes that link to a note with [[path]] or [[name]] wikilinks. Only AI-readable notes are searched. */
  async backlinks(vaultId: string, path: string, includeRestricted = false, limit = 50): Promise<Backlink[]> {
    const vault = this.vault(vaultId);
    const target = resolveMarkdownPath(vault.path, path);
    const targetPath = relative(vault.path, target).replaceAll("\\", "/").replace(/\.md$/i, "").toLowerCase();
    const targetName = targetPath.split("/").pop()!;
    const hits: Backlink[] = [];
    for (const file of await markdownFiles(vault.path)) {
      if (file === target) continue;
      const content = await readFile(file, "utf8");
      const access = aiAccessFor(content);
      if (access === "none" || (access === "restricted" && !includeRestricted)) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
        const matches = [...lines[index]!.matchAll(/\[\[([^\]|#]+)/g)].map((match) => match[1]!.trim().replace(/\.md$/i, "").toLowerCase());
        if (matches.some((link) => link === targetPath || link === targetName)) {
          hits.push({ path: relative(vault.path, file).replaceAll("\\", "/"), line: index + 1, excerpt: lines[index]!.trim().slice(0, 240), sha256: sha256(content) });
        }
      }
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private async proposed(requestInput: unknown): Promise<{ request: WriteRequest; absolute: string; path: string; before: string; after: string; preview: PreviewResult }> {
    const request = WriteRequestSchema.parse(requestInput);
    const vault = this.vault(request.vaultId);
    if (vault.mode !== "read-write") throw new Error(`Vault ${vault.id} is read-only.`);
    const route = vault.routes[request.route];
    if (!route) throw new Error(`Route ${request.route} is not allowed for vault ${vault.id}.`);
    if (route.policy === "deny") throw new Error(`Route ${request.route} is denied by policy.`);

    const { operation } = request;
    if (operation === "create" && !request.title) throw new Error("title is required for create operations.");
    if (operation === "set_frontmatter" && request.body !== undefined) throw new Error("body is not accepted for set_frontmatter operations; pass fields.");
    if (operation !== "set_frontmatter" && request.body === undefined) throw new Error(`body is required for ${operation} operations.`);
    if (operation === "set_frontmatter" && Object.keys(request.fields ?? {}).length === 0) throw new Error("fields is required for set_frontmatter operations.");
    if (request.fields && operation !== "create" && operation !== "set_frontmatter") throw new Error("fields is only accepted for create and set_frontmatter operations.");
    const blocked = Object.keys(request.fields ?? {}).filter((key) => !(route.fields ?? []).includes(key));
    if (blocked.length > 0) throw new Error(`Route ${request.route} does not allow setting ${blocked.join(", ")}. Writable fields: ${(route.fields ?? []).join(", ") || "none"}.`);

    let path: string;
    if (operation === "create") {
      const period = routePeriod(route);
      path = period
        ? `${route.folder}/${periodKey(period, request.sourceDate)}.md`
        : `${route.folder}/${request.sourceDate}-${slugify(request.title!, `note-${request.requestId}`)}.md`;
      if (request.targetPath) throw new Error("targetPath is not accepted for create operations.");
    } else {
      if (!request.targetPath) throw new Error(`targetPath is required for ${request.operation} operations.`);
      path = request.targetPath;
    }

    const absolute = resolveMarkdownPath(vault.path, path);
    const routeRoot = resolve(vault.path, route.folder);
    if (!isInside(vault.path, routeRoot)) throw new Error("Route folder escapes the configured vault root.");
    let before = "";
    try { before = await readFile(absolute, "utf8"); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    const modifies = request.operation !== "create";
    if (modifies && !isInside(routeRoot, absolute)) throw new Error("Write target is outside the selected route folder.");
    if (modifies && aiAccessFor(before) === "none") throw new Error("This note is excluded from AI access.");
    if (request.operation === "create" && before) throw new Error(`Note already exists: ${path}`);
    if (modifies && !before) throw new Error(`Write target does not exist: ${path}`);
    if (modifies && !request.expectedSha256) throw new Error(`expectedSha256 is required for ${request.operation} operations.`);
    if (request.operation === "update_section" && !request.section) throw new Error("section is required for update_section operations.");
    if (request.operation !== "update_section" && request.section) throw new Error("section is only accepted for update_section operations.");
    if (request.expectedSha256 && sha256(before) !== request.expectedSha256) throw new Error("Target note changed after it was read; refresh and preview again.");

    const now = this.today();
    const body = request.body?.trim() ?? "";
    const createdNote = () => [
      "---",
      `id: ${yamlValue(stableNoteId(vault.id, request.requestId))}`,
      `type: ${yamlValue(route.type)}`,
      `status: ${yamlValue(route.status)}`,
      `area: ${yamlValue(route.area)}`,
      `privacy: ${yamlValue("personal")}`,
      `ai_access: ${yamlValue("context")}`,
      `created: ${yamlValue(now)}`,
      `updated: ${yamlValue(now)}`,
      ...(route.moc ? [`moc: ${yamlValue(route.moc)}`] : []),
      `source: ${yamlValue(request.source)}`,
      `source_date: ${yamlValue(request.sourceDate)}`,
      "---",
      "",
      `# ${request.title}`,
      "",
      body,
      ""
    ].join("\n");
    let after: string;
    let shown = "";
    if (operation === "create") after = request.fields ? setFrontmatter(createdNote(), request.fields) : createdNote();
    else if (operation === "append") {
      const eol = detectEol(before);
      after = bumpUpdated(`${before.trimEnd()}${eol}${eol}${body.split(/\r?\n/).join(eol)}${eol}`, now);
    } else if (operation === "update_section") {
      const replaced = replaceSection(before, request.section!, body);
      after = bumpUpdated(replaced.content, now);
      shown = replaced.section;
    } else {
      after = bumpUpdated(setFrontmatter(before, request.fields!), now);
      shown = `---\n${frontmatterBlock(after)}\n---`;
    }
    const canonicalPath = relative(vault.path, absolute).replaceAll("\\", "/");
    const result: PreviewResult = {
      requestId: request.requestId,
      vaultId: vault.id,
      path: canonicalPath,
      operation: request.operation,
      policy: route.policy,
      beforeSha256: before ? sha256(before) : null,
      afterSha256: sha256(after),
      changedBytes: Buffer.byteLength(after) - Buffer.byteLength(before),
      preview: (shown || after).slice(0, 4000)
    };
    return { request, absolute, path: canonicalPath, before, after, preview: result };
  }

  async previewWrite(request: unknown): Promise<PreviewResult> {
    return (await this.proposed(request)).preview;
  }

  /**
   * Apply a write. Writes to one vault are serialized across processes by a lock file, so two agents
   * cannot both pass the hash check and overwrite each other. A pending receipt is written before the
   * note, so a retry after a crash finishes the write instead of failing.
   */
  async applyWrite(requestInput: unknown, context: WriteContext = {}): Promise<ApplyResult> {
    const request = WriteRequestSchema.parse(requestInput);
    const vault = this.vault(request.vaultId);
    await mkdir(join(this.config.stateDir, "requests"), { recursive: true });
    const receiptPath = join(this.config.stateDir, "requests", `${request.requestId}.json`);
    const fingerprint = sha256(JSON.stringify(request));

    return this.withVaultLock(vault.id, async () => {
      const prior = await readReceipt(receiptPath);
      if (prior && prior.fingerprint !== fingerprint) throw new Error("requestId was already used with different content.");
      if (prior && prior.state !== "pending") return { replayed: true, ...prior.result, appliedAt: prior.result.appliedAt! };
      if (prior && await this.currentSha256(vault, prior.result.path) === prior.result.afterSha256) {
        return this.recordApplied(request, receiptPath, fingerprint, prior.result, context);
      }

      const proposed = await this.proposed(request);
      if (proposed.preview.policy === "review" && request.approved !== true) {
        throw new Error(`Route ${request.route} requires user approval; preview the write, show it to the user, then apply with approved: true.`);
      }
      await replaceFile(receiptPath, JSON.stringify({ fingerprint, state: "pending", result: proposed.preview } satisfies Receipt, null, 2));
      await mkdir(dirname(proposed.absolute), { recursive: true });
      if (request.operation === "create") await writeFile(proposed.absolute, proposed.after, { encoding: "utf8", flag: "wx" });
      else await replaceFile(proposed.absolute, proposed.after);
      return this.recordApplied(request, receiptPath, fingerprint, proposed.preview, context);
    });
  }

  private async recordApplied(request: WriteRequest, receiptPath: string, fingerprint: string, preview: PreviewResult, context: WriteContext): Promise<ApplyResult> {
    const result = { ...preview, appliedAt: this.now().toISOString() };
    await replaceFile(receiptPath, JSON.stringify({ fingerprint, state: "applied", result } satisfies Receipt, null, 2));
    const { preview: _content, ...auditable } = result; // the audit log records what changed, never note text
    const event = { event: "write_applied", ...auditable, source: request.source, ...(context.client ? { client: context.client } : {}) };
    await appendFile(join(this.config.stateDir, "audit.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    return { replayed: false, ...result };
  }

  private async currentSha256(vault: VaultConfig, path: string): Promise<string | null> {
    try { return sha256(await readFile(resolveMarkdownPath(vault.path, path), "utf8")); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private withVaultLock<T>(vaultId: string, work: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.config.stateDir, "locks", `${vaultId}.lock`), `Vault ${vaultId} is busy with another write; try again.`, work);
  }

  async validate(vaultId?: string) {
    const required = ["id", "type", "status", "area", "privacy", "ai_access"];
    const vaults = vaultId ? [this.vault(vaultId)] : this.config.vaults;
    const issues: Array<{ vaultId: string; path: string; message: string }> = [];
    let notes = 0;
    for (const vault of vaults) {
      for (const file of await markdownFiles(vault.path)) {
        if (relative(vault.path, file).replaceAll("\\", "/") === "AGENTS.md") continue;
        notes += 1;
        const block = frontmatterBlock(await readFile(file, "utf8"));
        for (const key of required) {
          if (!new RegExp(`^${key}:`, "m").test(block)) issues.push({ vaultId: vault.id, path: relative(vault.path, file).replaceAll("\\", "/"), message: `Missing frontmatter field: ${key}` });
        }
      }
    }
    return { ok: issues.length === 0, notes, issues };
  }

  /**
   * Bring a vault made by `lifekernel init` up to the current layout. Without `apply` it only reports
   * the changes. This is an owner action for the CLI, not an agent tool: it edits templates and the
   * vault marker, which no route covers.
   */
  async migrate(vaultId: string, options: { apply?: boolean; starterDir?: string } = {}) {
    const vault = this.vault(vaultId);
    if (options.apply && vault.mode !== "read-write") throw new Error(`Vault ${vault.id} is read-only.`);
    const plan = async () => {
      const markerPath = join(vault.path, ".lifekernel", "vault.json");
      let marker: { layoutVersion?: number };
      try { marker = JSON.parse(await readFile(markerPath, "utf8")) as { layoutVersion?: number }; } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new Error(`Vault ${vault.id} has no .lifekernel/vault.json, so it was not created by lifekernel init.`);
      }
      const from = marker.layoutVersion ?? 1;
      const changes: Array<{ path: string; change: string; absolute: string; content: string }> = [];
      const optional = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      /** Add blank frontmatter keys a note lacks, and apply an optional body change, as one planned change. */
      const extend = async (path: string, keys: string[], body?: (content: string) => { content: string; change: string } | null) => {
        const absolute = resolveMarkdownPath(vault.path, path);
        const before = await optional(absolute);
        const data = before === null ? null : readFrontmatter(before);
        if (before === null || data === null) return;
        const missing = keys.filter((key) => !(key in data));
        let content = missing.length > 0 ? setFrontmatter(before, Object.fromEntries(missing.map((key) => [key, ""]))) : before;
        const notes = missing.length > 0 ? [`add frontmatter fields ${missing.join(", ")}`] : [];
        const edited = body?.(content);
        if (edited) { content = edited.content; notes.push(edited.change); }
        if (content !== before) changes.push({ path, change: notes.join("; "), absolute, content });
      };
      if (from < 3) {
        await extend("_templates/Daily.md", Object.keys(DAILY_TEMPLATE_FIELDS), (content) => {
          if (/^## Plan for today\s*$/m.test(content) || !/^## Day summary\s*$/m.test(content)) return null;
          const eol = detectEol(content);
          return { content: content.replace(/^## Day summary[ \t]*$/m, `## Plan for today${eol}${eol}## Day summary`), change: "add section Plan for today" };
        });
        await extend(vault.methodNote ?? "system/Method.md", RITUAL_FIELDS);
        if (options.starterDir) {
          const starterTemplates = join(options.starterDir, "_templates");
          for (const name of (await readdir(starterTemplates)).filter((file) => file.endsWith(".md")).sort()) {
            const absolute = join(vault.path, "_templates", name);
            if (await optional(absolute) !== null) continue;
            changes.push({ path: `_templates/${name}`, change: "add template", absolute, content: await readFile(join(starterTemplates, name), "utf8") });
          }
        }
      }
      if (from < LAYOUT_VERSION) {
        changes.push({ path: ".lifekernel/vault.json", change: `layoutVersion ${from} -> ${LAYOUT_VERSION}`, absolute: markerPath, content: `${JSON.stringify({ ...marker, layoutVersion: LAYOUT_VERSION }, null, 2)}\n` });
      }
      return { from, changes };
    };
    const report = (from: number, changes: Array<{ path: string; change: string }>, applied: boolean) => ({
      vaultId: vault.id, from, to: Math.max(from, LAYOUT_VERSION), changes: changes.map(({ path, change }) => ({ path, change })), applied
    });
    if (!options.apply) { const { from, changes } = await plan(); return report(from, changes, false); }
    return this.withVaultLock(vault.id, async () => {
      const { from, changes } = await plan();
      for (const change of changes) {
        await mkdir(dirname(change.absolute), { recursive: true });
        await replaceFile(change.absolute, change.content);
      }
      if (changes.length > 0) {
        const event = { event: "vault_migrated", vaultId: vault.id, from, to: LAYOUT_VERSION, paths: changes.map((change) => change.path), at: this.now().toISOString() };
        await appendFile(join(this.config.stateDir, "audit.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
      }
      return report(from, changes, changes.length > 0);
    });
  }

  async recentAudit(limit = 20) {
    try {
      const raw = await readFile(join(this.config.stateDir, "audit.jsonl"), "utf8");
      return raw.trim().split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
