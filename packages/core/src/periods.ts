export const PERIODS = ["day", "week", "month", "quarter"] as const;
export type Period = (typeof PERIODS)[number];

const DAY_MS = 86_400_000;

function parseDate(date: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!parsed || parsed.toISOString().slice(0, 10) !== date) throw new Error("date must be a real calendar date in YYYY-MM-DD form.");
  return parsed;
}

const format = (date: Date) => date.toISOString().slice(0, 10);

/** ISO 8601 week: weeks start on Monday, and week 1 contains the year's first Thursday. */
function isoWeek(date: Date): { year: number; week: number } {
  const thursday = new Date(date.getTime() + (4 - (date.getUTCDay() || 7)) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return { year: thursday.getUTCFullYear(), week: Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7) };
}

/** The file key for the period containing `date`: 2026-10-01, 2026-W40, 2026-10, or 2026-Q4. */
export function periodKey(period: Period, date: string): string {
  const day = parseDate(date);
  if (period === "day") return date;
  if (period === "week") {
    const { year, week } = isoWeek(day);
    return `${year}-W${String(week).padStart(2, "0")}`;
  }
  if (period === "month") return date.slice(0, 7);
  return `${day.getUTCFullYear()}-Q${Math.floor(day.getUTCMonth() / 3) + 1}`;
}

/** First and last calendar date of the period containing `date`, inclusive. */
export function periodRange(period: Period, date: string): { start: string; end: string } {
  const day = parseDate(date);
  if (period === "day") return { start: date, end: date };
  if (period === "week") {
    const monday = new Date(day.getTime() - ((day.getUTCDay() || 7) - 1) * DAY_MS);
    return { start: format(monday), end: format(new Date(monday.getTime() + 6 * DAY_MS)) };
  }
  const months = period === "month" ? 1 : 3;
  const firstMonth = period === "month" ? day.getUTCMonth() : Math.floor(day.getUTCMonth() / 3) * 3;
  const start = new Date(Date.UTC(day.getUTCFullYear(), firstMonth, 1));
  const end = new Date(Date.UTC(day.getUTCFullYear(), firstMonth + months, 0));
  return { start: format(start), end: format(end) };
}
