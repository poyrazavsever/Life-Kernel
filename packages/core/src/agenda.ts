import { readFrontmatter } from "./frontmatter.js";
import type { LifeKernel } from "./index.js";
import { periodKey, periodRange, type Period } from "./periods.js";
import type { RitualId } from "./rituals.js";
import { readSection } from "./sections.js";
import { parseTasks, type Task } from "./tasks.js";
import { addDays, weekday } from "./time.js";

type Kernel = Pick<LifeKernel, "readNote" | "dailyNote" | "periodNote" | "listNotes" | "openTasks">;

/** A section of a note, with the note it came from so the agent can cite it. */
export interface SourcedText { source: string; text: string }
export interface DaySummary { date: string; source: string | null; energy?: number; focus_hours?: number; morning_plan?: string; circle?: string }
export interface PeriodStats { days: number; daysRecorded: number; circlesDone: number; circlesSkipped: number; averageEnergy: number | null; focusHours: number }
type AgendaTask = Task & { path: string };

const PLAN = "schedule/Near-Term Plan.md";
const AVAILABILITY = "schedule/Availability.md";
const CAPACITY = "schedule/Capacity.md";
const WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

async function note(kernel: Kernel, vaultId: string, path: string) {
  try { return await kernel.readNote(vaultId, path); } catch { return null; }
}

async function section(kernel: Kernel, vaultId: string, path: string, heading: string): Promise<SourcedText | null> {
  const found = await note(kernel, vaultId, path);
  const text = found && readSection(found.content, heading);
  return text ? { source: found.path, text } : null;
}

async function daily(kernel: Kernel, vaultId: string, date: string) {
  try {
    const found = await kernel.dailyNote(vaultId, date);
    return found.exists ? found : null;
  } catch { return null; }
}

async function period(kernel: Kernel, vaultId: string, kind: Period, date: string) {
  try { return await kernel.periodNote(vaultId, { period: kind, date }); } catch { return null; }
}

const numeric = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
const label = (value: unknown) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

async function daySummary(kernel: Kernel, vaultId: string, date: string): Promise<DaySummary> {
  const found = await daily(kernel, vaultId, date);
  const data = found ? readFrontmatter(found.content) ?? {} : {};
  const summary: DaySummary = { date, source: found?.path ?? null };
  const energy = numeric(data.energy), focus = numeric(data.focus_hours), morning = label(data.morning_plan), circle = label(data.circle);
  if (energy !== undefined) summary.energy = energy;
  if (focus !== undefined) summary.focus_hours = focus;
  if (morning) summary.morning_plan = morning;
  if (circle) summary.circle = circle;
  return summary;
}

function stats(days: DaySummary[]): PeriodStats {
  const energies = days.flatMap((day) => day.energy === undefined ? [] : [day.energy]);
  return {
    days: days.length,
    daysRecorded: days.filter((day) => day.source).length,
    circlesDone: days.filter((day) => day.circle === "done").length,
    circlesSkipped: days.filter((day) => day.circle === "skipped").length,
    averageEnergy: energies.length ? Math.round(energies.reduce((sum, value) => sum + value, 0) / energies.length * 10) / 10 : null,
    focusHours: days.reduce((sum, day) => sum + (day.focus_hours ?? 0), 0)
  };
}

function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** Fixed commitments from the Availability table whose Day cell names this weekday, "daily", "weekdays", or "weekends". */
async function commitmentsOn(kernel: Kernel, vaultId: string, date: string) {
  const table = await section(kernel, vaultId, AVAILABILITY, "Fixed commitments");
  if (!table) return [];
  const day = weekday(date);
  const matches = (cell: string) => {
    const value = cell.trim().toLowerCase();
    if (["daily", "every day", "everyday"].includes(value)) return true;
    if (value === "weekdays") return day <= 5;
    if (value === "weekends") return day >= 6;
    return value.split(/\s*[,/]\s*/).some((token) => token.length >= 3 && WEEKDAY_NAMES[day - 1]!.startsWith(token));
  };
  return table.text.split("\n")
    .filter((line) => line.trim().startsWith("|") && !/^\|\s*:?-{3,}/.test(line.trim()))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()))
    .filter((cells) => cells[0] && cells[0].toLowerCase() !== "day" && matches(cells[0]))
    .map(([dayCell, time, commitment]) => ({ day: dayCell!, time: time ?? "", commitment: commitment ?? "", source: table.source }));
}

/** Done tasks with a completion date inside the range, from project and area notes. */
async function completedTasks(kernel: Kernel, vaultId: string, start: string, end: string): Promise<AgendaTask[]> {
  const done: AgendaTask[] = [];
  for (const type of ["project", "area"]) {
    for (const listed of await kernel.listNotes(vaultId, { type, limit: 200 })) {
      const found = await note(kernel, vaultId, listed.path);
      if (!found) continue;
      for (const task of parseTasks(found.content)) if (task.status === "done" && task.done && task.done >= start && task.done <= end) done.push({ ...task, path: found.path });
    }
  }
  return done;
}

/** Active goals and whether any wikilink in their "Linked projects and areas" section reaches an active project. */
async function goals(kernel: Kernel, vaultId: string) {
  const activeProjects = await kernel.listNotes(vaultId, { type: "project", status: "active", limit: 200 });
  const projectKeys = new Set(activeProjects.flatMap((project) => {
    const path = project.path.replace(/\.md$/i, "").toLowerCase();
    return [path, path.split("/").pop()!];
  }));
  const result = [];
  for (const goal of await kernel.listNotes(vaultId, { type: "goal", status: "active", limit: 200 })) {
    const found = await note(kernel, vaultId, goal.path);
    const links = [...(readSection(found?.content ?? "", "Linked projects and areas") ?? "").matchAll(/\[\[([^\]|#]+)/g)].map((match) => match[1]!.trim().replace(/\.md$/i, "").toLowerCase());
    result.push({
      path: goal.path, title: goal.title,
      horizon: label(goal.frontmatter.horizon) ?? null, target_date: label(goal.frontmatter.target_date) ?? null,
      activeProjects: links.filter((link) => projectKeys.has(link)).length
    });
  }
  return result;
}

async function reviewNotes(kernel: Kernel, vaultId: string, kind: Period, dates: string[]) {
  const seen = new Map<string, { key: string; path: string; exists: boolean; status: string | null }>();
  for (const date of dates) {
    const found = await period(kernel, vaultId, kind, date);
    if (!found || seen.has(found.key)) continue;
    seen.set(found.key, { key: found.key, path: found.path, exists: found.exists, status: found.exists ? label(readFrontmatter(found.content)?.status) ?? null : null });
  }
  return [...seen.values()];
}

async function reviewNote(kernel: Kernel, vaultId: string, kind: Period, date: string) {
  const found = await period(kernel, vaultId, kind, date);
  return found ? { key: found.key, path: found.path, exists: found.exists, ...(found.exists ? { sha256: found.sha256 } : {}) } : null;
}

/**
 * What a ritual should cover, assembled without a model: plans, due and overdue tasks, the period's
 * daily fields, stalled projects, and goals, each with the note it came from.
 */
export async function buildAgenda(kernel: Kernel, vaultId: string, ritual: RitualId, date: string) {
  const openTasks = async (dueBy: string) => (await kernel.openTasks({ vaultId, dueBy, includeUndated: false })).map(({ sha256: _hash, vaultId: _vault, ...task }) => task);

  if (ritual === "morning-plan" || ritual === "daily-circle") {
    const yesterday = addDays(date, -1);
    const due = await openTasks(date);
    const tasks = { overdue: due.filter((task) => task.due! < date), dueToday: due.filter((task) => task.due === date) };
    const previous = await daySummary(kernel, vaultId, yesterday);
    const today = await daily(kernel, vaultId, date);
    const common = { ritual, date, tasks, todayNote: today ? { path: today.path, sha256: today.sha256 } : null };
    if (ritual === "morning-plan") {
      const yesterdayNote = previous.source;
      return {
        ...common,
        yesterday: { date: yesterday, circle: previous.circle ?? null },
        yesterdayFocus: yesterdayNote ? await section(kernel, vaultId, yesterdayNote, "Tomorrow's focus") : null,
        openLoops: yesterdayNote ? await section(kernel, vaultId, yesterdayNote, "Open loops") : null,
        plannedFocus: await section(kernel, vaultId, PLAN, "Focus for tomorrow"),
        commitments: await commitmentsOn(kernel, vaultId, date)
      };
    }
    return {
      ...common,
      // A missing circle yesterday is offered as a short catch-up, never as a reproach.
      catchUp: previous.circle ? null : { date: yesterday, noteExists: previous.source !== null },
      planForToday: today ? (readSection(today.content, "Plan for today") || null) : null,
      thisWeek: await section(kernel, vaultId, PLAN, "This week")
    };
  }

  if (ritual === "weekly-review") {
    const { start, end } = periodRange("week", date);
    const days = await Promise.all(datesBetween(start, end).map((day) => daySummary(kernel, vaultId, day)));
    const previousReview = await period(kernel, vaultId, "week", addDays(start, -1));
    const decisions = (await kernel.listNotes(vaultId, { type: "decision", limit: 200 })).filter((decision) => {
      const changed = [decision.frontmatter.created, decision.frontmatter.decided_on].map(label);
      return changed.some((value) => value && value >= start && value <= end);
    }).map((decision) => ({ path: decision.path, title: decision.title, status: label(decision.frontmatter.status) ?? null }));
    return {
      ritual, date, period: { key: periodKey("week", date), start, end },
      reviewNote: await reviewNote(kernel, vaultId, "week", date),
      days, stats: stats(days),
      completedTasks: await completedTasks(kernel, vaultId, start, end),
      overdueTasks: await openTasks(end),
      stalledProjects: (await kernel.listNotes(vaultId, { type: "project", status: "active", updatedBefore: start, limit: 200 })).map((project) => ({ path: project.path, title: project.title, updated: label(project.frontmatter.updated) ?? null })),
      decisions,
      previousCommitments: previousReview?.exists ? await section(kernel, vaultId, previousReview.path, "Next week's commitments") : null,
      statedCapacity: await section(kernel, vaultId, CAPACITY, "Stated capacity"),
      observedCapacity: await section(kernel, vaultId, CAPACITY, "Observed capacity")
    };
  }

  const kind: Period = ritual === "monthly-review" ? "month" : "quarter";
  const { start, end } = periodRange(kind, date);
  const dates = datesBetween(start, end);
  const days = await Promise.all(dates.map((day) => daySummary(kernel, vaultId, day)));
  const base = {
    ritual, date, period: { key: periodKey(kind, date), start, end },
    reviewNote: await reviewNote(kernel, vaultId, kind, date),
    stats: stats(days),
    goals: await goals(kernel, vaultId)
  };
  if (kind === "month") return { ...base, weeklyReviews: await reviewNotes(kernel, vaultId, "week", dates.filter((_, index) => index % 7 === 0).concat(end)) };
  return {
    ...base,
    monthlyReviews: await reviewNotes(kernel, vaultId, "month", [start, addDays(start, 40), end]),
    areas: (await kernel.listNotes(vaultId, { type: "area", status: "active", limit: 200 })).map((area) => ({ path: area.path, title: area.title }))
  };
}
