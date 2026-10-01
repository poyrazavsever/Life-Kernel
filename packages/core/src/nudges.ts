import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { actionLink, actionSecret, verifyAction, type NudgeAction } from "./actions.js";
import { ChannelSchema, createChannel, defaultDeps, type Channel, type ChannelDeps, type NudgeMessage } from "./channels.js";
import { replaceFile, withFileLock } from "./files.js";
import type { LifeKernel, RitualReport, WriteContext } from "./index.js";
import { RITUAL_IDS, RITUALS, type QuietHours, type RitualId, type RitualStatus } from "./rituals.js";
import { addDays } from "./time.js";

export const NotificationsSchema = z.object({
  enabled: z.boolean().default(true),
  /** The vault whose rituals are announced (default: the first personal vault). */
  vaultId: z.string().optional(),
  locale: z.enum(["en", "tr"]).default("en"),
  /** One gentle follow-up this many minutes after a reminder, if the ritual is still open; 0 turns follow-ups off. */
  followUpAfterMinutes: z.number().int().min(0).max(24 * 60).default(90),
  /** Public https origin of the HTTP server; when set, ntfy reminders carry signed snooze and skip buttons. */
  actionBaseUrl: z.string().url().refine((value) => value.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(value), "actionBaseUrl must be https, or http on localhost.").optional(),
  channels: z.array(ChannelSchema).default([])
});
export type NotificationsConfig = z.infer<typeof NotificationsSchema>;
type Locale = NotificationsConfig["locale"];

interface Phrases { title: string; reminder: string; followUp: string; prompt: string }
interface Labels { start: string; snooze: string; skip: string }
export const TEXT: Record<Locale, Record<RitualId, Phrases> & { catchUp: string; test: { title: string; body: string }; labels: Labels }> = {
  en: {
    "morning-plan": { title: "Morning plan", reminder: "Five minutes to choose today's focus.", followUp: "Still a good moment to choose today's focus.", prompt: "Let's plan the day." },
    "daily-circle": { title: "Daily circle", reminder: "Ten to twenty minutes to close the day.", followUp: "There is still time to close the day tonight, or to skip it.", prompt: "Let's do the circle." },
    "weekly-review": { title: "Weekly review", reminder: "Time to look back at the week and choose next week's commitments.", followUp: "Your weekly review is waiting; another day is fine too.", prompt: "Let's do the weekly review." },
    "monthly-review": { title: "Monthly review", reminder: "Time to check the month against your goals.", followUp: "Your monthly review is waiting; another day is fine too.", prompt: "Let's do the monthly review." },
    "quarterly-review": { title: "Quarterly review", reminder: "Time to check your direction for the next quarter.", followUp: "Your quarterly review is waiting; another day is fine too.", prompt: "Let's do the quarterly review." },
    catchUp: "Yesterday's circle was not recorded; a two-minute catch-up is an option.",
    test: { title: "Life Kernel", body: "Test notification. Ritual reminders will arrive like this." },
    labels: { start: "Start", snooze: "Snooze 1h", skip: "Skip" }
  },
  tr: {
    "morning-plan": { title: "Sabah planı", reminder: "Bugünün odağını seçmek için beş dakika.", followUp: "Bugünün odağını seçmek için hâlâ iyi bir an.", prompt: "Günü planlayalım." },
    "daily-circle": { title: "Günlük değerlendirme", reminder: "Günü kapatmak için 10-20 dakika.", followUp: "Bu akşam günü kapatmak için hâlâ zaman var; istersen atlayabilirsin.", prompt: "Günlük değerlendirmeyi yapalım." },
    "weekly-review": { title: "Haftalık değerlendirme", reminder: "Haftaya geri bakıp gelecek haftanın taahhütlerini seçme zamanı.", followUp: "Haftalık değerlendirme seni bekliyor; başka bir gün de olur.", prompt: "Haftalık değerlendirmeyi yapalım." },
    "monthly-review": { title: "Aylık değerlendirme", reminder: "Ayı hedeflerinle karşılaştırma zamanı.", followUp: "Aylık değerlendirme seni bekliyor; başka bir gün de olur.", prompt: "Aylık değerlendirmeyi yapalım." },
    "quarterly-review": { title: "Çeyreklik değerlendirme", reminder: "Önümüzdeki çeyreğin yönünü gözden geçirme zamanı.", followUp: "Çeyreklik değerlendirme seni bekliyor; başka bir gün de olur.", prompt: "Çeyreklik değerlendirmeyi yapalım." },
    catchUp: "Dünün değerlendirmesi kaydedilmedi; istersen iki dakikalık bir telafi yapabiliriz.",
    test: { title: "Life Kernel", body: "Deneme bildirimi. Ritüel hatırlatmaları böyle gelecek." },
    labels: { start: "Başla", snooze: "1 saat ertele", skip: "Atla" }
  }
};

const AGENDA_TEXT: Record<Locale, { focus: string; plan: string; due: (n: number) => string; overdue: (n: number) => string; commitments: (n: number) => string; days: (n: number, of: number) => string; done: (n: number) => string; goals: (n: number) => string; noProject: (n: number) => string }> = {
  en: {
    focus: "Focus", plan: "Plan",
    due: (n) => `${n} due today`, overdue: (n) => `${n} overdue`, commitments: (n) => `${n} fixed commitments`,
    days: (n, of) => `${n}/${of} days recorded`, done: (n) => `${n} tasks done`,
    goals: (n) => `${n} active goals`, noProject: (n) => `${n} without a project`
  },
  tr: {
    focus: "Odak", plan: "Plan",
    due: (n) => `bugün ${n} iş`, overdue: (n) => `${n} gecikmiş`, commitments: (n) => `${n} sabit randevu`,
    days: (n, of) => `${of} günün ${n}'i kayıtlı`, done: (n) => `${n} iş tamamlandı`,
    goals: (n) => `${n} aktif hedef`, noProject: (n) => `${n} hedefin projesi yok`
  }
};

/** Operational state for reminders. It lives in the state directory, never in the vault. */
export interface NudgeState {
  sent: Record<string, { reminder?: string; followUp?: string }>;
  snoozed: Partial<Record<RitualId, string>>;
  pausedUntil?: string;
  /** Nonces of action links already used, with their expiry in Unix seconds. */
  usedActions?: Record<string, number>;
  /** The next Telegram update to read. */
  telegramOffset?: number;
}

export interface Nudge { ritual: RitualId; occurrence: string; kind: "reminder" | "follow-up" }
export interface HeldNudge { ritual: RitualId; reason: "paused" | "quiet-hours" | "snoozed" | "already-sent" }

const OPEN_STATES = new Set(["due", "overdue"]);
const STATE_RETENTION_DAYS = 35;

export function occurrenceOf(report: RitualReport, status: RitualStatus): string {
  const ritual = RITUALS.find((candidate) => candidate.id === status.id)!;
  return `${status.id}:${ritual.kind === "daily" ? report.date : status.period}`;
}

function inQuietHours(time: string, quiet: QuietHours | null): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end ? time >= quiet.start && time < quiet.end : time >= quiet.start || time < quiet.end;
}

/**
 * Decide which reminders to send now: one reminder when a ritual becomes due or overdue, and at most one
 * follow-up after `followUpAfterMinutes`. Nothing is sent while paused, snoozed, or in quiet hours.
 */
export function decideNudges(report: RitualReport, state: NudgeState, options: { now: Date; followUpAfterMinutes: number }): { nudges: Nudge[]; held: HeldNudge[] } {
  const nudges: Nudge[] = [];
  const held: HeldNudge[] = [];
  const localTime = report.now.slice(11, 16);
  for (const status of report.rituals) {
    if (!OPEN_STATES.has(status.state)) continue;
    const ritual = status.id;
    if (state.pausedUntil && state.pausedUntil >= report.date) { held.push({ ritual, reason: "paused" }); continue; }
    const snoozedUntil = state.snoozed[ritual];
    if (snoozedUntil && new Date(snoozedUntil) > options.now) { held.push({ ritual, reason: "snoozed" }); continue; }
    if (inQuietHours(localTime, report.quietHours)) { held.push({ ritual, reason: "quiet-hours" }); continue; }
    const occurrence = occurrenceOf(report, status);
    const sent = state.sent[occurrence];
    if (!sent?.reminder) { nudges.push({ ritual, occurrence, kind: "reminder" }); continue; }
    const followUpDue = options.followUpAfterMinutes > 0 && !sent.followUp && options.now.getTime() - new Date(sent.reminder).getTime() >= options.followUpAfterMinutes * 60_000;
    if (followUpDue) nudges.push({ ritual, occurrence, kind: "follow-up" });
    else held.push({ ritual, reason: "already-sent" });
  }
  return { nudges, held };
}

/** One short line from the ritual's agenda: counts and a focus line, never more than a sentence of note text. */
function agendaLine(ritual: RitualId, agenda: Record<string, unknown>, locale: Locale): string {
  const t = AGENDA_TEXT[locale];
  const first = (value: unknown) => {
    const text = typeof value === "string" ? value : (value as { text?: string } | null)?.text;
    const line = text?.split("\n").map((part) => part.replace(/^[-*]\s+/, "").trim()).find(Boolean);
    return line ? (line.length > 80 ? `${line.slice(0, 79)}…` : line) : null;
  };
  const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
  const parts: string[] = [];
  if (ritual === "morning-plan" || ritual === "daily-circle") {
    const tasks = agenda.tasks as { overdue: unknown[]; dueToday: unknown[] };
    const focus = ritual === "morning-plan" ? first(agenda.plannedFocus) ?? first(agenda.yesterdayFocus) : first(agenda.planForToday);
    if (focus) parts.push(`${ritual === "morning-plan" ? t.focus : t.plan}: ${focus}`);
    if (count(tasks.dueToday)) parts.push(t.due(count(tasks.dueToday)));
    if (count(tasks.overdue)) parts.push(t.overdue(count(tasks.overdue)));
    if (ritual === "morning-plan" && count(agenda.commitments)) parts.push(t.commitments(count(agenda.commitments)));
  } else if (ritual === "weekly-review") {
    const stats = agenda.stats as { days: number; daysRecorded: number };
    parts.push(t.days(stats.daysRecorded, stats.days));
    if (count(agenda.completedTasks)) parts.push(t.done(count(agenda.completedTasks)));
    if (count(agenda.overdueTasks)) parts.push(t.overdue(count(agenda.overdueTasks)));
  } else {
    const goals = (agenda.goals ?? []) as Array<{ activeProjects: number }>;
    if (goals.length) parts.push(t.goals(goals.length));
    const lonely = goals.filter((goal) => goal.activeProjects === 0).length;
    if (lonely) parts.push(t.noProject(lonely));
  }
  return parts.join(" · ");
}

export function nudgeMessage(nudge: Nudge, locale: Locale, extra: { agendaLine?: string; catchUp?: boolean } = {}): NudgeMessage {
  const phrases = TEXT[locale][nudge.ritual];
  const lines = [nudge.kind === "reminder" ? phrases.reminder : phrases.followUp];
  if (extra.agendaLine) lines.push(extra.agendaLine);
  if (extra.catchUp) lines.push(TEXT[locale].catchUp);
  const labels = TEXT[locale].labels;
  return { ritual: nudge.ritual, kind: nudge.kind, title: phrases.title, body: lines.join("\n"), prompt: phrases.prompt, startLabel: labels.start, actions: [{ action: "snooze", label: labels.snooze }, { action: "skip", label: labels.skip }] };
}

function statePath(kernel: LifeKernel): string {
  return join(kernel.config.stateDir, "nudges.json");
}

export async function loadNudgeState(kernel: LifeKernel): Promise<NudgeState> {
  try {
    const raw = JSON.parse(await readFile(statePath(kernel), "utf8")) as Partial<NudgeState>;
    return { ...raw, sent: raw.sent ?? {}, snoozed: raw.snoozed ?? {} };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sent: {}, snoozed: {} };
    throw error;
  }
}

async function saveNudgeState(kernel: LifeKernel, state: NudgeState, now: Date): Promise<void> {
  const cutoff = now.getTime() - STATE_RETENTION_DAYS * 86_400_000;
  for (const [key, entry] of Object.entries(state.sent)) if (new Date(entry.followUp ?? entry.reminder ?? 0).getTime() < cutoff) delete state.sent[key];
  for (const [ritual, until] of Object.entries(state.snoozed)) if (new Date(until).getTime() < now.getTime()) delete state.snoozed[ritual as RitualId];
  for (const [nonce, expires] of Object.entries(state.usedActions ?? {})) if (expires * 1000 < now.getTime()) delete state.usedActions![nonce];
  await replaceFile(statePath(kernel), `${JSON.stringify(state, null, 2)}\n`);
}

const nudgeLock = (kernel: LifeKernel) => join(kernel.config.stateDir, "locks", "nudges.lock");

/** Change the reminder state under the scheduler's lock. */
export async function updateState(kernel: LifeKernel, now: Date, change: (state: NudgeState) => void): Promise<NudgeState> {
  return withFileLock(nudgeLock(kernel), "Another reminder check is running; try again.", async () => {
    const state = await loadNudgeState(kernel);
    change(state);
    await saveNudgeState(kernel, state, now);
    return state;
  });
}

async function audit(kernel: LifeKernel, event: Record<string, unknown>): Promise<void> {
  await appendFile(join(kernel.config.stateDir, "audit.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export function notificationsVault(kernel: LifeKernel): string {
  const configured = kernel.config.notifications?.vaultId;
  if (configured) return configured;
  return (kernel.config.vaults.find((vault) => vault.kind === "personal") ?? kernel.config.vaults[0]!).id;
}

export interface TickResult {
  enabled: boolean;
  dryRun: boolean;
  at: string;
  vaultId?: string;
  sent: Array<Nudge & { channels: Array<{ type: string; ok: boolean; error?: string }> }>;
  held: HeldNudge[];
  error?: string;
}

/**
 * Check the rituals once and send what is due. Safe to run every few minutes from any number of
 * schedulers: a lock serializes checks and the state file remembers what was already sent.
 * The audit log records which reminders went out on which channels, never their text.
 */
export async function tick(kernel: LifeKernel, options: { at?: Date; dryRun?: boolean; channels?: Channel[]; deps?: ChannelDeps } = {}): Promise<TickResult> {
  const now = options.at ?? new Date();
  const dryRun = options.dryRun ?? false;
  const config = kernel.config.notifications;
  const result: TickResult = { enabled: Boolean(config?.enabled), dryRun, at: now.toISOString(), sent: [], held: [] };
  if (!config?.enabled) return result;
  const vaultId = result.vaultId = notificationsVault(kernel);
  const channels = options.channels ?? config.channels.map((channel) => createChannel(channel, options.deps ?? defaultDeps()));
  if (channels.length === 0) { result.error = "No notification channels are configured."; return result; }

  return withFileLock(nudgeLock(kernel), "Another reminder check is running.", async () => {
    const state = await loadNudgeState(kernel);
    const report = await kernel.ritualStatus(vaultId, { at: now });
    if (report.error) result.error = report.error;
    const { nudges, held } = decideNudges(report, state, { now, followUpAfterMinutes: config.followUpAfterMinutes });
    result.held = held;
    const yesterday = addDays(report.date, -1);
    const missedYesterday = report.rituals.find((status) => status.id === "daily-circle")?.missed?.includes(yesterday) ?? false;

    for (const nudge of nudges) {
      const targets = channels.filter((channel) => !channel.config.rituals || channel.config.rituals.includes(nudge.ritual));
      let line: string | undefined;
      if (targets.some((channel) => channel.config.content === "agenda")) {
        line = agendaLine(nudge.ritual, await kernel.ritualAgenda(vaultId, nudge.ritual, { date: report.date }) as Record<string, unknown>, config.locale) || undefined;
      }
      const catchUp = nudge.ritual === "morning-plan" && nudge.kind === "reminder" && missedYesterday;
      const outcomes: TickResult["sent"][number]["channels"] = [];
      // Signed links are made once per nudge and shared by the channels that can show them.
      const links: Partial<Record<NudgeAction, string>> = {};
      if (config.actionBaseUrl && !dryRun) {
        const secret = await actionSecret(kernel);
        for (const action of ["snooze", "skip"] as const) links[action] = actionLink(config.actionBaseUrl, secret, { ritual: nudge.ritual, action, occurrence: nudge.occurrence, now });
      }
      for (const channel of targets) {
        const base = nudgeMessage(nudge, config.locale, { ...(channel.config.content === "agenda" && line ? { agendaLine: line } : {}), catchUp });
        const message = { ...base, actions: base.actions!.map((action) => links[action.action] ? { ...action, url: links[action.action] } : action) };
        if (dryRun) { outcomes.push({ type: channel.type, ok: true }); continue; }
        try { await channel.send(message); outcomes.push({ type: channel.type, ok: true }); } catch (error: unknown) {
          outcomes.push({ type: channel.type, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      result.sent.push({ ...nudge, channels: outcomes });
      if (dryRun) continue;
      // A reminder that reached no channel is retried on the next check.
      if (outcomes.some((outcome) => outcome.ok)) {
        const entry = state.sent[nudge.occurrence] ??= {};
        entry[nudge.kind === "reminder" ? "reminder" : "followUp"] = now.toISOString();
      }
      await audit(kernel, { event: "nudge_sent", vaultId, ritual: nudge.ritual, occurrence: nudge.occurrence, kind: nudge.kind, channels: outcomes, at: now.toISOString() });
    }
    if (!dryRun) await saveNudgeState(kernel, state, now);
    return result;
  });
}

/** Send a harmless test message to every configured channel, or to one by index. */
export async function sendTestNotification(kernel: LifeKernel, options: { index?: number; deps?: ChannelDeps } = {}) {
  const config = kernel.config.notifications;
  if (!config) throw new Error("Add a notifications section to the config first.");
  const selected = options.index === undefined ? config.channels : [config.channels[options.index]].filter((channel) => channel !== undefined);
  if (selected.length === 0) throw new Error("No matching notification channel is configured.");
  const text = TEXT[config.locale].test;
  const results = [];
  for (const channelConfig of selected) {
    const channel = createChannel(channelConfig, options.deps ?? defaultDeps());
    try { await channel.send({ ritual: "test", kind: "test", title: text.title, body: text.body, prompt: TEXT[config.locale]["daily-circle"].prompt }); results.push({ type: channel.type, ok: true }); } catch (error: unknown) {
      results.push({ type: channel.type, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** Hold reminders for one ritual until a time. */
export async function snoozeRitual(kernel: LifeKernel, ritual: RitualId, minutes: number, at: Date = new Date()) {
  if (!(RITUAL_IDS as readonly string[]).includes(ritual)) throw new Error(`Unknown ritual: ${ritual}. Known: ${RITUAL_IDS.join(", ")}.`);
  if (!(minutes > 0 && minutes <= 7 * 24 * 60)) throw new Error("Snooze between one minute and seven days.");
  const until = new Date(at.getTime() + minutes * 60_000).toISOString();
  await updateState(kernel, at, (state) => { state.snoozed[ritual] = until; });
  await audit(kernel, { event: "nudge_snoozed", ritual, until, at: at.toISOString() });
  return { ritual, until };
}

/** Hold every reminder through a date (inclusive), or resume with `null`. */
export async function pauseNudges(kernel: LifeKernel, until: string | null, at: Date = new Date()) {
  if (until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error("Pause until a date in YYYY-MM-DD form.");
  await updateState(kernel, at, (state) => { if (until) state.pausedUntil = until; else delete state.pausedUntil; });
  await audit(kernel, { event: until ? "nudges_paused" : "nudges_resumed", ...(until ? { until } : {}), at: at.toISOString() });
  return { pausedUntil: until };
}

/**
 * Record that the user skipped a ritual, as evidence in the vault: `morning_plan` or `circle` on the daily
 * note, or `status: skipped` on the review note, plus the reason when one is given. Writes go through routes.
 */
export async function skipRitual(kernel: LifeKernel, vaultId: string, ritual: RitualId, reason: string, context: WriteContext = {}) {
  const definition = RITUALS.find((candidate) => candidate.id === ritual);
  if (!definition) throw new Error(`Unknown ritual: ${ritual}. Known: ${RITUAL_IDS.join(", ")}.`);
  const found = definition.kind === "daily" ? await kernel.dailyNote(vaultId) : await kernel.periodNote(vaultId, { period: definition.period });
  const field = definition.kind === "daily" ? definition.field : "status";
  const label = definition.kind === "daily" ? found.date : found.key;
  const base = { vaultId, route: found.route, source: "lifekernel skip", sourceDate: found.date, approved: true };
  const id = `skip-${ritual}-${label}`;
  const sentence = `Skipped the ${ritual.replace("-", " ")}${reason.trim() ? `: ${reason.trim()}` : "."}`;
  if (!found.exists) {
    return [await kernel.applyWrite({ ...base, requestId: id, operation: "create", title: label, body: sentence, fields: { [field]: "skipped" } }, context)];
  }
  const marked = await kernel.applyWrite({ ...base, requestId: id, operation: "set_frontmatter", targetPath: found.path, expectedSha256: found.sha256, fields: { [field]: "skipped" } }, context);
  if (!reason.trim()) return [marked];
  return [marked, await kernel.applyWrite({ ...base, requestId: `${id}-reason`, operation: "append", targetPath: found.path, expectedSha256: marked.afterSha256, body: sentence }, context)];
}

/**
 * Snooze a ritual for an hour or record a skip, on behalf of a button. Both are idempotent, so a button
 * pressed twice or delivered twice changes nothing more.
 */
export async function applyNudgeAction(kernel: LifeKernel, ritual: RitualId, action: NudgeAction, source: string, at: Date = new Date()) {
  if (action === "snooze") return snoozeRitual(kernel, ritual, 60, at);
  return skipRitual(kernel, notificationsVault(kernel), ritual, "", { client: { name: source } });
}

/**
 * Perform the action behind a signed link from a notification. A link works once, until it expires, and
 * only for the reminder it came with; one from an earlier day changes nothing.
 */
export async function performLinkedAction(kernel: LifeKernel, query: Record<string, unknown>, at: Date = new Date()) {
  const verified = verifyAction(await actionSecret(kernel), query, at);
  await updateState(kernel, at, (state) => {
    state.usedActions ??= {};
    if (state.usedActions[verified.nonce]) throw new Error("This link was already used.");
    state.usedActions[verified.nonce] = verified.expires;
  });
  const report = await kernel.ritualStatus(notificationsVault(kernel), { at });
  const status = report.rituals.find((candidate) => candidate.id === verified.ritual);
  if (!status || occurrenceOf(report, status) !== verified.occurrence) {
    await audit(kernel, { event: "nudge_action_stale", ritual: verified.ritual, action: verified.action, at: at.toISOString() });
    return { ok: false, ritual: verified.ritual, action: verified.action, message: "This reminder is from an earlier day; nothing changed." };
  }
  await applyNudgeAction(kernel, verified.ritual, verified.action, "notification-link", at);
  await audit(kernel, { event: "nudge_action", ritual: verified.ritual, action: verified.action, via: "link", at: at.toISOString() });
  return { ok: true, ritual: verified.ritual, action: verified.action, message: verified.action === "snooze" ? "Snoozed for one hour." : "Skipped." };
}
