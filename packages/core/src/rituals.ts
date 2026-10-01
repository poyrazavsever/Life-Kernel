import { periodKey, periodRange, type Period } from "./periods.js";
import { addDays, daysInMonth, isoInZone, weekday, zonedInstant } from "./time.js";

export const RITUAL_IDS = ["morning-plan", "daily-circle", "weekly-review", "monthly-review", "quarterly-review"] as const;
export type RitualId = (typeof RITUAL_IDS)[number];
export type RitualState = "not-scheduled" | "upcoming" | "due" | "overdue" | "done" | "skipped";
export type Outcome = "done" | "skipped" | null;

export interface DailyRitual { id: RitualId; kind: "daily"; timeKey: string; daysKey: string; field: string }
export interface PeriodRitual { id: RitualId; kind: "period"; period: Exclude<Period, "day">; dayKey: string; timeKey: string }
export type RitualDefinition = DailyRitual | PeriodRitual;

/** Daily rituals are marked on the daily note; reviews are complete when their period note's status says so. */
export const RITUALS: RitualDefinition[] = [
  { id: "morning-plan", kind: "daily", timeKey: "morning_plan_time", daysKey: "morning_plan_days", field: "morning_plan" },
  { id: "daily-circle", kind: "daily", timeKey: "daily_circle_time", daysKey: "daily_circle_days", field: "circle" },
  { id: "weekly-review", kind: "period", period: "week", dayKey: "weekly_review_day", timeKey: "weekly_review_time" },
  { id: "monthly-review", kind: "period", period: "month", dayKey: "monthly_review_day", timeKey: "monthly_review_time" },
  { id: "quarterly-review", kind: "period", period: "quarter", dayKey: "quarterly_review_day", timeKey: "quarterly_review_time" }
];

/** Method note frontmatter keys that hold the user's rhythm. Onboarding writes them with set_frontmatter. */
export const RITUAL_FIELDS = [...RITUALS.flatMap((ritual) => ritual.kind === "daily" ? [ritual.timeKey, ritual.daysKey] : [ritual.dayKey, ritual.timeKey]), "quiet_hours"];

/** How long a daily ritual stays `due` before it counts as `overdue`. */
const DAILY_GRACE_MS = 2 * 60 * 60 * 1000;
/** How far back daily history is read for the streak and the last completion. */
const HISTORY_DAYS = 60;
/** Missed daily rituals are reported for this many days. */
const MISSED_WINDOW_DAYS = 7;

const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const text = (value: unknown) => value === undefined || value === null ? "" : String(value).trim().toLowerCase();

export function parseTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`"${raw}" is not a time; use 24-hour HH:MM.`);
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
}

function dayNumber(token: string): number {
  const index = token.length >= 3 ? DAY_NAMES.findIndex((name) => name.startsWith(token)) : -1;
  if (index < 0) throw new Error(`"${token}" is not a weekday; use mon, tue, wed, thu, fri, sat, or sun.`);
  return index + 1;
}

/** Weekdays a daily ritual runs on: blank or "daily" is every day; also "weekdays", "weekends", "mon,wed", "mon-fri". */
export function parseDays(value: unknown): Set<number> {
  const raw = text(value);
  if (!raw || raw === "daily" || raw === "every day") return new Set([1, 2, 3, 4, 5, 6, 7]);
  const days = new Set<number>();
  for (const token of raw.split(/\s*,\s*/).filter(Boolean)) {
    if (token === "weekdays") [1, 2, 3, 4, 5].forEach((day) => days.add(day));
    else if (token === "weekends") [6, 7].forEach((day) => days.add(day));
    else if (token.includes("-")) {
      const [from, to] = token.split("-").map((part) => dayNumber(part.trim())) as [number, number];
      for (let day = from; ; day = day % 7 + 1) { days.add(day); if (day === to) break; }
    } else days.add(dayNumber(token));
  }
  return days;
}

export type DayRule = { kind: "weekday"; weekday: number } | { kind: "date"; day: number } | { kind: "last" } | { kind: "nth"; which: "first" | "last"; weekday: number };

/**
 * When in the period a review falls. Weekly: a weekday (default sun). Monthly and quarterly (in the
 * quarter's last month): a day number, "last", "first-mon", or "last-sun" (default "last").
 */
export function parseDayRule(value: unknown, period: Exclude<Period, "day">): DayRule {
  const raw = text(value);
  if (period === "week") return { kind: "weekday", weekday: dayNumber(raw || "sun") };
  if (!raw || raw === "last") return { kind: "last" };
  if (/^\d{1,2}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 31) return { kind: "date", day: Number(raw) };
  const match = /^(first|last)-([a-z]+)$/.exec(raw);
  if (match) return { kind: "nth", which: match[1] as "first" | "last", weekday: dayNumber(match[2]!) };
  throw new Error(`"${raw}" is not a review day; use a day number, last, first-mon, or last-sun.`);
}

/** The scheduled date of a review within the period that contains `date`. */
export function scheduledDate(rule: DayRule, period: Exclude<Period, "day">, date: string): string {
  const { start, end } = periodRange(period, date);
  if (rule.kind === "weekday") return addDays(start, rule.weekday - 1);
  const monthStart = period === "quarter" ? `${end.slice(0, 7)}-01` : start;
  const [year, month] = monthStart.split("-").map(Number) as [number, number];
  const length = daysInMonth(year, month);
  if (rule.kind === "last") return addDays(monthStart, length - 1);
  if (rule.kind === "date") return addDays(monthStart, Math.min(rule.day, length) - 1);
  if (rule.which === "first") return addDays(monthStart, (rule.weekday - weekday(monthStart) + 7) % 7);
  const monthEnd = addDays(monthStart, length - 1);
  return addDays(monthEnd, -((weekday(monthEnd) - rule.weekday + 7) % 7));
}

export interface QuietHours { start: string; end: string }

export function parseQuietHours(value: unknown): QuietHours | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(raw);
  if (!match) throw new Error(`"${raw}" is not a quiet-hours range; use HH:MM-HH:MM.`);
  return { start: parseTime(match[1])!, end: parseTime(match[2])! };
}

export interface RitualStatus {
  id: RitualId;
  state: RitualState;
  /** The schedule as the method note states it. */
  schedule?: string;
  dueAt?: string;
  /** Date (daily) or period key (reviews) of the most recent completion. */
  lastDone?: string;
  /** Consecutive scheduled days completed; skipped days neither count nor break it. Daily rituals only. */
  streak?: number;
  /** Recent scheduled days or the previous period without a completion or a recorded skip. */
  missed?: string[];
  /** The period key of the review this status is about. */
  period?: string;
  error?: string;
}

export interface RitualContext {
  now: Date;
  timeZone: string;
  /** Today's date in the time zone. */
  today: string;
  /** The earliest daily note. Days before it are not counted as missed, so a new vault starts clean. */
  firstActiveDate: string | null;
  dailyOutcome(date: string, field: string): Promise<Outcome>;
  periodOutcome(period: Exclude<Period, "day">, date: string): Promise<Outcome>;
}

async function evaluateDaily(ritual: DailyRitual, method: Record<string, unknown>, context: RitualContext): Promise<RitualStatus> {
  const time = parseTime(method[ritual.timeKey]);
  const days = parseDays(method[ritual.daysKey]);
  if (!time) return { id: ritual.id, state: "not-scheduled" };
  const { today, now, timeZone } = context;
  const status: RitualStatus = { id: ritual.id, state: "upcoming", schedule: `${time} ${text(method[ritual.daysKey]) || "every day"}` };

  const todayOutcome = await context.dailyOutcome(today, ritual.field);
  let streak = todayOutcome === "done" ? 1 : 0;
  let counting = true;
  let lastDone = todayOutcome === "done" ? today : undefined;
  const missed: string[] = [];
  for (let back = 1; back <= HISTORY_DAYS; back += 1) {
    const date = addDays(today, -back);
    if (context.firstActiveDate === null || date < context.firstActiveDate) break;
    if (!days.has(weekday(date))) continue;
    const outcome = await context.dailyOutcome(date, ritual.field);
    if (outcome === "done") { lastDone ??= date; if (counting) streak += 1; }
    else if (outcome === null) { counting = false; if (back <= MISSED_WINDOW_DAYS) missed.push(date); }
    if (!counting && lastDone && back > MISSED_WINDOW_DAYS) break;
  }
  status.streak = streak;
  if (lastDone) status.lastDone = lastDone;
  if (missed.length > 0) status.missed = missed.sort();

  if (days.has(weekday(today))) {
    const dueAt = zonedInstant(today, time, timeZone);
    status.dueAt = isoInZone(dueAt, timeZone);
    if (todayOutcome) status.state = todayOutcome;
    else if (now < dueAt) status.state = "upcoming";
    else status.state = now.getTime() - dueAt.getTime() < DAILY_GRACE_MS ? "due" : "overdue";
  } else {
    let next = addDays(today, 1);
    while (!days.has(weekday(next))) next = addDays(next, 1);
    status.dueAt = isoInZone(zonedInstant(next, time, timeZone), timeZone);
    status.state = todayOutcome ?? "upcoming";
  }
  return status;
}

async function evaluatePeriod(ritual: PeriodRitual, method: Record<string, unknown>, context: RitualContext): Promise<RitualStatus> {
  const time = parseTime(method[ritual.timeKey]);
  const rule = parseDayRule(method[ritual.dayKey], ritual.period);
  if (!time) return { id: ritual.id, state: "not-scheduled" };
  const { today, now, timeZone } = context;
  const day = scheduledDate(rule, ritual.period, today);
  const dueAt = zonedInstant(day, time, timeZone);
  const status: RitualStatus = {
    id: ritual.id, state: "upcoming", schedule: `${text(method[ritual.dayKey]) || (ritual.period === "week" ? "sun" : "last")} ${time}`,
    dueAt: isoInZone(dueAt, timeZone), period: periodKey(ritual.period, today)
  };
  const outcome = await context.periodOutcome(ritual.period, today);
  if (outcome) status.state = outcome;
  else if (now < dueAt) status.state = "upcoming";
  else status.state = today === day ? "due" : "overdue";
  if (outcome === "done") status.lastDone = status.period!;

  const previousDate = addDays(periodRange(ritual.period, today).start, -1);
  if (context.firstActiveDate !== null && previousDate >= context.firstActiveDate) {
    const previous = await context.periodOutcome(ritual.period, previousDate);
    if (previous === null) status.missed = [periodKey(ritual.period, previousDate)];
    if (previous === "done") status.lastDone ??= periodKey(ritual.period, previousDate);
  }
  return status;
}

/** Evaluate every ritual against the method note's schedule. A malformed schedule is reported, not thrown. */
export async function evaluateRituals(method: Record<string, unknown>, context: RitualContext): Promise<RitualStatus[]> {
  const statuses: RitualStatus[] = [];
  for (const ritual of RITUALS) {
    try { statuses.push(ritual.kind === "daily" ? await evaluateDaily(ritual, method, context) : await evaluatePeriod(ritual, method, context)); } catch (error: unknown) {
      statuses.push({ id: ritual.id, state: "not-scheduled", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return statuses;
}
