import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { completedTasks, daily, datesBetween, daySummary, type DaySummary, type Kernel } from "./agenda.js";
import { readFrontmatter } from "./frontmatter.js";
import { periodKey, periodRange, type Period } from "./periods.js";
import { parseDays, parseTime } from "./rituals.js";
import { readSection } from "./sections.js";
import { addDays, weekday } from "./time.js";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
/** Fewer samples than this make an observation too weak to state. */
const MIN_SAMPLES = 3;
/** A task named in a day's plan on this many days and still open counts as repeatedly planned. */
const REPEAT_DAYS = 3;

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const average = (values: number[]) => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const fold = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ı/g, "i").replace(/\s+/g, " ").trim();

export interface RitualConsistency { scheduled: number; done: number; skipped: number; missed: number; doneRate: number | null; missedDates: string[] }

export interface Insights {
  vaultId: string;
  period: { kind: Exclude<Period, "day">; key: string; start: string; end: string; through: string };
  days: { total: number; recorded: number };
  energy: { average: number | null; samples: number; byWeekday: Partial<Record<(typeof WEEKDAYS)[number], { average: number; samples: number }>>; lowest: Array<{ date: string; energy: number }>; firstHalf: number | null; secondHalf: number | null };
  focus: { totalHours: number; recordedDays: number; averagePerRecordedDay: number | null; stated: { weekday: number | null; weekend: number | null; source: string } | null; statedForRecordedDays: number | null; shareOfStated: number | null };
  rituals: { morningPlan: RitualConsistency | null; dailyCircle: RitualConsistency | null };
  tasks: { completed: number; overdue: number; repeatedlyPlanned: Array<{ text: string; path: string; plannedOn: string[] }> };
  /** Plain statements with their evidence, only where the samples support them. Never advice. */
  observations: string[];
}

/** Stated capacity from schedule/Capacity.md: "Focused work hours per weekday: 4" and the weekend line. */
async function statedCapacity(kernel: Kernel, vaultId: string): Promise<Insights["focus"]["stated"]> {
  const note = await kernel.readNote(vaultId, "schedule/Capacity.md").catch(() => null);
  const section = note && readSection(note.content, "Stated capacity");
  if (!section) return null;
  const number = (pattern: RegExp) => { const match = pattern.exec(section); return match ? Number(match[1]) : null; };
  const stated = { weekday: number(/per weekday:\s*([\d.]+)/i), weekend: number(/per weekend day:\s*([\d.]+)/i), source: note.path };
  return stated.weekday === null && stated.weekend === null ? null : stated;
}

async function firstDailyNote(kernel: Kernel, vaultId: string): Promise<string | null> {
  const vault = kernel.config.vaults.find((candidate) => candidate.id === vaultId);
  const route = vault && Object.values(vault.routes).find((candidate) => candidate.type === "daily");
  if (!vault || !route) return null;
  const names = await readdir(resolve(vault.path, route.folder)).catch(() => [] as string[]);
  return names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).map((name) => name.slice(0, 10)).sort()[0] ?? null;
}

function consistency(days: DaySummary[], scheduled: Set<number>, field: "morning_plan" | "circle", today: string, firstActive: string | null): RitualConsistency {
  const result: RitualConsistency = { scheduled: 0, done: 0, skipped: 0, missed: 0, doneRate: null, missedDates: [] };
  for (const day of days) {
    if (!scheduled.has(weekday(day.date)) || (firstActive && day.date < firstActive) || !firstActive) continue;
    const outcome = day[field];
    // Today only counts once it has an outcome; it may still happen.
    if (day.date === today && outcome !== "done" && outcome !== "skipped") continue;
    result.scheduled += 1;
    if (outcome === "done") result.done += 1;
    else if (outcome === "skipped") result.skipped += 1;
    else { result.missed += 1; result.missedDates.push(day.date); }
  }
  result.doneRate = result.scheduled ? round(result.done / result.scheduled, 2) : null;
  return result;
}

/**
 * Deterministic numbers about a week, month, or quarter, each traceable to dated notes: energy and its
 * weekday pattern, focus against stated capacity, ritual consistency, and tasks planned again and again.
 * Days after `today` are not counted.
 */
export async function periodInsights(kernel: Kernel, vaultId: string, kind: Exclude<Period, "day">, date: string, today: string): Promise<Insights> {
  const { start, end } = periodRange(kind, date);
  const through = end < today ? end : today;
  const dates = through >= start ? datesBetween(start, through) : [];
  const days = await Promise.all(dates.map((day) => daySummary(kernel, vaultId, day)));

  const energies = days.flatMap((day) => day.energy === undefined ? [] : [{ date: day.date, energy: day.energy }]);
  const byWeekday: Insights["energy"]["byWeekday"] = {};
  for (const [index, name] of WEEKDAYS.entries()) {
    const values = energies.filter((entry) => weekday(entry.date) === index + 1).map((entry) => entry.energy);
    if (values.length) byWeekday[name] = { average: average(values)!, samples: values.length };
  }
  const half = Math.ceil(energies.length / 2);
  const lowestValue = Math.min(...energies.map((entry) => entry.energy));

  const focusDays = days.filter((day) => day.focus_hours !== undefined);
  const totalHours = round(focusDays.reduce((sum, day) => sum + day.focus_hours!, 0));
  const stated = await statedCapacity(kernel, vaultId);
  const statedHours = stated ? focusDays.reduce((sum, day) => sum + ((weekday(day.date) >= 6 ? stated.weekend : stated.weekday) ?? 0), 0) : null;

  const methodNote = kernel.config.vaults.find((candidate) => candidate.id === vaultId)?.methodNote ?? "system/Method.md";
  const method = readFrontmatter((await kernel.readNote(vaultId, methodNote).catch(() => null))?.content ?? "") ?? {};
  const firstActive = await firstDailyNote(kernel, vaultId);
  const ritual = (timeKey: string, daysKey: string, field: "morning_plan" | "circle") => {
    try { return parseTime(method[timeKey]) ? consistency(days, parseDays(method[daysKey]), field, today, firstActive) : null; } catch { return null; }
  };

  // Plans name tasks in prose; a still-open task named on several days is being carried, not done.
  const plans = new Map<string, string>();
  for (const day of dates) {
    const note = await daily(kernel, vaultId, day);
    if (!note) continue;
    plans.set(day, fold([readSection(note.content, "Plan for today"), readSection(note.content, "Tomorrow's focus")].filter(Boolean).join("\n")));
  }
  const open = await kernel.openTasks({ vaultId, limit: 500 });
  const repeatedlyPlanned = open
    .filter((task) => task.text.length >= 6)
    .map((task) => ({ text: task.text, path: task.path, plannedOn: [...plans].filter(([, text]) => text.includes(fold(task.text))).map(([day]) => day) }))
    .filter((task) => task.plannedOn.length >= REPEAT_DAYS);

  const insights: Insights = {
    vaultId,
    period: { kind, key: periodKey(kind, date), start, end, through },
    days: { total: dates.length, recorded: days.filter((day) => day.source).length },
    energy: {
      average: average(energies.map((entry) => entry.energy)), samples: energies.length, byWeekday,
      lowest: energies.length ? energies.filter((entry) => entry.energy === lowestValue).map(({ date: day, energy }) => ({ date: day, energy })) : [],
      firstHalf: energies.length >= 2 * MIN_SAMPLES ? average(energies.slice(0, half).map((entry) => entry.energy)) : null,
      secondHalf: energies.length >= 2 * MIN_SAMPLES ? average(energies.slice(half).map((entry) => entry.energy)) : null
    },
    focus: {
      totalHours, recordedDays: focusDays.length, averagePerRecordedDay: average(focusDays.map((day) => day.focus_hours!)),
      stated, statedForRecordedDays: statedHours, shareOfStated: statedHours ? round(totalHours / statedHours, 2) : null
    },
    rituals: { morningPlan: ritual("morning_plan_time", "morning_plan_days", "morning_plan"), dailyCircle: ritual("daily_circle_time", "daily_circle_days", "circle") },
    tasks: { completed: (await completedTasks(kernel, vaultId, start, through)).length, overdue: open.filter((task) => task.due && task.due < through).length, repeatedlyPlanned },
    observations: []
  };
  insights.observations = observe(insights);
  return insights;
}

function observe(insights: Insights): string[] {
  const notes: string[] = [];
  const { energy, focus, rituals, tasks } = insights;
  if (energy.samples >= MIN_SAMPLES && energy.average !== null) {
    const weakest = Object.entries(energy.byWeekday).filter(([, value]) => value.samples >= 2).sort((a, b) => a[1].average - b[1].average)[0];
    if (weakest && energy.average - weakest[1].average >= 0.8) notes.push(`Energy averaged ${weakest[1].average} on ${weakest[0]} (${weakest[1].samples} days) against ${energy.average} overall (${energy.samples} days).`);
    if (energy.firstHalf !== null && energy.secondHalf !== null && Math.abs(energy.secondHalf - energy.firstHalf) >= 0.8) notes.push(`Energy moved from ${energy.firstHalf} in the first half of the recorded days to ${energy.secondHalf} in the second.`);
  }
  if (focus.recordedDays >= MIN_SAMPLES && focus.shareOfStated !== null) notes.push(`Focus was ${focus.totalHours} hours over ${focus.recordedDays} recorded days, ${Math.round(focus.shareOfStated * 100)}% of the stated ${focus.statedForRecordedDays} hours for those days.`);
  for (const [name, value] of [["Daily circle", rituals.dailyCircle], ["Morning plan", rituals.morningPlan]] as const) {
    if (value && value.scheduled >= MIN_SAMPLES) notes.push(`${name} done on ${value.done} of ${value.scheduled} scheduled days${value.skipped ? `, skipped on ${value.skipped}` : ""}${value.missed ? `, missing on ${value.missedDates.join(", ")}` : ""}.`);
  }
  for (const task of tasks.repeatedlyPlanned) notes.push(`"${task.text}" (${task.path}) was in the plan on ${task.plannedOn.join(", ")} and is still open.`);
  return notes;
}
