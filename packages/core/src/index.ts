import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const RouteSchema = z.object({
  folder: z.string().min(1),
  type: z.string().min(1),
  status: z.string().min(1),
  area: z.string().min(1),
  moc: z.string().optional(),
  policy: z.enum(["auto", "review", "deny"]).default("review")
});

export type RoutePolicy = z.infer<typeof RouteSchema>["policy"];

const VaultSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/),
  kind: z.enum(["personal", "project", "research"]),
  path: z.string().min(1),
  mode: z.enum(["read-only", "read-write"]),
  routes: z.record(RouteSchema).default({}),
  bundle: z.array(z.string().min(1)).optional()
});

function isValidTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: value }); return true; } catch { return false; }
}

const ConfigSchema = z.object({
  version: z.literal(1),
  stateDir: z.string().default("./.lifekernel-data"),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA time zone.").default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  vaults: z.array(VaultSchema).min(1)
});

export const WriteRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, "requestId must be 8-128 characters: letters, digits, dot, underscore, or hyphen."),
  vaultId: z.string().min(1),
  operation: z.enum(["create", "append", "update_section"]),
  route: z.string().min(1),
  title: z.string().min(1).max(180),
  body: z.string().min(1),
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
}

export interface Backlink { path: string; line: number; excerpt: string; sha256: string }

function slugify(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || `note-${Date.now()}`;
}

function yamlValue(value: string): string {
  return JSON.stringify(value);
}

type AiAccess = "context" | "restricted" | "none";

function aiAccessFor(content: string): AiAccess | null {
  if (!content.startsWith("---")) return null;
  const frontmatter = content.split(/^---\s*$/m, 3)[1] ?? "";
  const match = frontmatter.match(/^ai_access:\s*["']?(context|restricted|none)["']?\s*$/m);
  return (match?.[1] as AiAccess | undefined) ?? null;
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

function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) if (lines[index]!.trim() === "---") return index + 1;
  return 0;
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

/** Replace the body under one heading, up to the next heading of the same or higher level. */
export function replaceSection(content: string, heading: string, body: string): { content: string; section: string } {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const wanted = heading.replace(/^#+\s*/, "").trim();
  const headings: Array<{ index: number; level: number; text: string }> = [];
  let fence: string | null = null;
  for (let index = frontmatterEnd(lines); index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (match) headings.push({ index, level: match[1]!.length, text: match[2]!.trim() });
  }
  const matches = headings.filter((candidate) => candidate.text === wanted);
  if (matches.length === 0) throw new Error(`Section not found: ${wanted}`);
  if (matches.length > 1) throw new Error(`Section heading is ambiguous: ${wanted}`);
  const target = matches[0]!;
  const next = headings.find((candidate) => candidate.index > target.index && candidate.level <= target.level);
  const replacement = [lines[target.index]!, "", ...body.trim().split(/\r?\n/), ""];
  const rebuilt = [...lines.slice(0, target.index), ...replacement, ...(next ? lines.slice(next.index) : [])];
  return { content: rebuilt.join(eol).replace(/(\r?\n)*$/, eol), section: replacement.join(eol).trim() };
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

export async function loadConfig(configPath: string): Promise<LifeKernelConfig> {
  const absoluteConfig = resolve(configPath);
  const raw = JSON.parse(await readFile(absoluteConfig, "utf8")) as unknown;
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
  constructor(public readonly config: LifeKernelConfig) {}

  private vault(id: string): VaultConfig {
    const vault = this.config.vaults.find((candidate) => candidate.id === id);
    if (!vault) throw new Error(`Unknown vault: ${id}`);
    return vault;
  }

  listVaults() {
    return this.config.vaults.map(({ id, kind, mode, routes }) => ({
      id, kind, mode,
      routes: Object.entries(routes).map(([name, route]) => ({ name, folder: route.folder, type: route.type, policy: route.policy }))
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

  async search(query: string, vaultId?: string, limit = 20, includeRestricted = false): Promise<SearchHit[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) throw new Error("Search query cannot be empty.");
    const vaults = vaultId ? [this.vault(vaultId)] : this.config.vaults;
    const hits: SearchHit[] = [];
    for (const vault of vaults) {
      for (const file of await markdownFiles(vault.path)) {
        const content = await readFile(file, "utf8");
        const access = aiAccessFor(content);
        if (access === "none" || (access === "restricted" && !includeRestricted)) continue;
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (hits.length >= limit || !line.toLocaleLowerCase().includes(needle)) return;
          const start = Math.max(0, index - 1);
          const end = Math.min(lines.length, index + 2);
          hits.push({
            vaultId: vault.id,
            path: relative(vault.path, file).replaceAll("\\", "/"),
            lineStart: start + 1,
            lineEnd: end,
            excerpt: lines.slice(start, end).join("\n"),
            sha256: sha256(content)
          });
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  /** Look up the single daily note for a date (default: today in the configured time zone). */
  async dailyNote(vaultId: string, date?: string, routeName?: string) {
    const vault = this.vault(vaultId);
    const day = date ?? localDate(this.config.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("date must be YYYY-MM-DD.");
    const candidates = Object.entries(vault.routes).filter(([name, route]) => route.type === "daily" && (!routeName || name === routeName));
    if (candidates.length === 0) throw new Error(`Vault ${vault.id} has no daily route${routeName ? ` named ${routeName}` : ""}.`);
    if (candidates.length > 1) throw new Error("Several daily routes exist; pass routeName.");
    const [name, route] = candidates[0]!;
    const path = `${route.folder}/${day}.md`;
    try {
      const note = await this.readNote(vault.id, path);
      return { vaultId: vault.id, date: day, route: name, policy: route.policy, exists: true as const, path: note.path, content: note.content, sha256: note.sha256 };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { vaultId: vault.id, date: day, route: name, policy: route.policy, exists: false as const, path };
    }
  }

  /**
   * Assemble the minimum context for a session: the vault's bundle notes, today's daily note,
   * and the most recent earlier daily notes, within a character budget.
   * Each entry carries the hash of the full note so a later write can cite it.
   */
  async contextBundle(vaultId: string, options: { date?: string; includeRestricted?: boolean; maxChars?: number; recentDaily?: number } = {}): Promise<ContextBundle> {
    const vault = this.vault(vaultId);
    const date = options.date ?? localDate(this.config.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD.");
    const includeRestricted = options.includeRestricted ?? false;
    let remaining = Math.min(Math.max(options.maxChars ?? 24000, 1000), 200000);
    const paths = [...(vault.bundle ?? DEFAULT_BUNDLE)];

    const dailyRoute = Object.values(vault.routes).find((route) => route.type === "daily");
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
    return { vaultId: vault.id, date, notes, skipped, totalChars };
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

    let path: string;
    if (request.operation === "create") {
      path = route.type === "daily"
        ? `${route.folder}/${request.sourceDate}.md`
        : `${route.folder}/${request.sourceDate}-${slugify(request.title)}.md`;
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

    const now = localDate(this.config.timezone);
    const created = [
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
      request.body.trim(),
      ""
    ].join("\n");
    let after: string;
    let shown = "";
    if (request.operation === "create") after = created;
    else if (request.operation === "append") after = bumpUpdated(`${before.trimEnd()}\n\n${request.body.trim()}\n`, now);
    else {
      const replaced = replaceSection(before, request.section!, request.body);
      after = bumpUpdated(replaced.content, now);
      shown = replaced.section;
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

  async applyWrite(requestInput: unknown): Promise<ApplyResult> {
    const request = WriteRequestSchema.parse(requestInput);
    await mkdir(join(this.config.stateDir, "requests"), { recursive: true });
    const receiptPath = join(this.config.stateDir, "requests", `${request.requestId}.json`);
    const fingerprint = sha256(JSON.stringify(request));
    try {
      const prior = JSON.parse(await readFile(receiptPath, "utf8")) as { fingerprint: string; result: Omit<ApplyResult, "replayed"> };
      if (prior.fingerprint !== fingerprint) throw new Error("requestId was already used with different content.");
      return { replayed: true, ...prior.result };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const proposed = await this.proposed(request);
    if (proposed.preview.policy === "review" && request.approved !== true) {
      throw new Error(`Route ${request.route} requires user approval; preview the write, show it to the user, then apply with approved: true.`);
    }
    await mkdir(dirname(proposed.absolute), { recursive: true });
    await writeFile(proposed.absolute, proposed.after, { encoding: "utf8", flag: "wx" }).catch(async (error: unknown) => {
      if (request.operation === "create" || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await writeFile(proposed.absolute, proposed.after, "utf8");
    });
    const result = { ...proposed.preview, appliedAt: new Date().toISOString() };
    await writeFile(receiptPath, JSON.stringify({ fingerprint, result }, null, 2), "utf8");
    await appendFile(join(this.config.stateDir, "audit.jsonl"), `${JSON.stringify({ event: "write_applied", ...result, source: request.source })}\n`, "utf8");
    return { replayed: false, ...result };
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
        const content = await readFile(file, "utf8");
        const block = content.startsWith("---\n") ? content.split("---", 3)[1] ?? "" : "";
        for (const key of required) {
          if (!new RegExp(`^${key}:`, "m").test(block)) issues.push({ vaultId: vault.id, path: relative(vault.path, file).replaceAll("\\", "/"), message: `Missing frontmatter field: ${key}` });
        }
      }
    }
    return { ok: issues.length === 0, notes, issues };
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
