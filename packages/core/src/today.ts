import type { LifeKernel, RitualReport } from "./index.js";
import { TEXT, type NotificationsConfig } from "./nudges.js";
import type { RitualState } from "./rituals.js";

type Locale = NotificationsConfig["locale"];

export interface TodaySummary {
  date: string;
  focus: { text: string; source: string } | null;
  dueToday: Array<{ text: string; path: string }>;
  overdue: Array<{ text: string; path: string; due: string }>;
  inbox: number;
  rituals: RitualReport["rituals"];
}

const STATES: Record<Locale, Record<RitualState, string>> = {
  en: { "not-scheduled": "not scheduled", upcoming: "upcoming", due: "due now", overdue: "overdue", done: "done", skipped: "skipped" },
  tr: { "not-scheduled": "planlı değil", upcoming: "yaklaşıyor", due: "zamanı geldi", overdue: "gecikti", done: "yapıldı", skipped: "atlandı" }
};
const WORDS: Record<Locale, { focus: string; noFocus: string; due: string; overdue: string; inbox: (n: number) => string; rituals: string }> = {
  en: { focus: "Focus", noFocus: "No focus chosen yet.", due: "Due today", overdue: "Overdue", inbox: (n) => `${n} item${n === 1 ? "" : "s"} in the inbox`, rituals: "Rituals" },
  tr: { focus: "Odak", noFocus: "Henüz odak seçilmedi.", due: "Bugün", overdue: "Gecikmiş", inbox: (n) => `Inbox'ta ${n} öğe`, rituals: "Ritüeller" }
};

type Agenda = { tasks: { overdue: Array<{ text: string; path: string; due?: string }>; dueToday: Array<{ text: string; path: string }> }; inbox: { count: number } };
type Sourced = { text: string; source: string } | null;

/** Today at a glance: the chosen focus, due and overdue tasks, the inbox, and ritual states. */
export async function todaySummary(kernel: LifeKernel, vaultId: string): Promise<TodaySummary> {
  const morning = await kernel.ritualAgenda(vaultId, "morning-plan") as Agenda & { date: string; plannedFocus: Sourced; yesterdayFocus: Sourced; todayNote: { path: string } | null };
  const circle = await kernel.ritualAgenda(vaultId, "daily-circle") as Agenda & { planForToday: string | null };
  const firstLine = (text: string) => text.split("\n").map((line) => line.replace(/^[-*]\s+/, "").trim()).find(Boolean) ?? text;
  const focus = circle.planForToday && morning.todayNote
    ? { text: firstLine(circle.planForToday), source: morning.todayNote.path }
    : morning.plannedFocus ? { text: firstLine(morning.plannedFocus.text), source: morning.plannedFocus.source }
    : morning.yesterdayFocus ? { text: firstLine(morning.yesterdayFocus.text), source: morning.yesterdayFocus.source } : null;
  return {
    date: morning.date,
    focus,
    dueToday: morning.tasks.dueToday.map(({ text, path }) => ({ text, path })),
    overdue: morning.tasks.overdue.map(({ text, path, due }) => ({ text, path, due: due! })),
    inbox: morning.inbox.count,
    rituals: (await kernel.ritualStatus(vaultId)).rituals
  };
}

export function formatRituals(rituals: RitualReport["rituals"], locale: Locale): string[] {
  return rituals.filter((status) => status.state !== "not-scheduled").map((status) => {
    const time = status.dueAt && status.state !== "done" && status.state !== "skipped" ? ` (${status.dueAt.slice(11, 16)})` : "";
    return `• ${TEXT[locale][status.id].title}: ${STATES[locale][status.state]}${time}`;
  });
}

export function formatToday(summary: TodaySummary, locale: Locale = "en"): string {
  const words = WORDS[locale];
  const lines = [summary.date, summary.focus ? `${words.focus}: ${summary.focus.text}` : words.noFocus];
  if (summary.dueToday.length) lines.push("", `${words.due}:`, ...summary.dueToday.map((task) => `• ${task.text}`));
  if (summary.overdue.length) lines.push("", `${words.overdue}:`, ...summary.overdue.map((task) => `• ${task.text} (${task.due})`));
  if (summary.inbox) lines.push("", words.inbox(summary.inbox));
  const rituals = formatRituals(summary.rituals, locale);
  if (rituals.length) lines.push("", `${words.rituals}:`, ...rituals);
  return lines.join("\n");
}
