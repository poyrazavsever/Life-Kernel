import { parseDayRule, parseDays, parseTime, RITUALS, scheduledDate, type DayRule, type RitualId } from "./rituals.js";
import { addDays, weekday } from "./time.js";

const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const MINUTES: Record<RitualId, number> = { "morning-plan": 10, "daily-circle": 20, "weekly-review": 45, "monthly-review": 45, "quarterly-review": 60 };
const TITLES: Record<"en" | "tr", Record<RitualId, string>> = {
  en: { "morning-plan": "Morning plan", "daily-circle": "Daily circle", "weekly-review": "Weekly review", "monthly-review": "Monthly review", "quarterly-review": "Quarterly review" },
  tr: { "morning-plan": "Sabah planı", "daily-circle": "Günlük değerlendirme", "weekly-review": "Haftalık değerlendirme", "monthly-review": "Aylık değerlendirme", "quarterly-review": "Çeyreklik değerlendirme" }
};

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold content lines at 75 octets, as RFC 5545 requires. */
function fold(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const char of line) {
    if (Buffer.byteLength(current + char, "utf8") > (parts.length === 0 ? 75 : 74)) { parts.push(current); current = ""; }
    current += char;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function dayPart(rule: DayRule): string {
  if (rule.kind === "weekday") return `BYDAY=${BYDAY[rule.weekday - 1]}`;
  if (rule.kind === "last") return "BYMONTHDAY=-1";
  if (rule.kind === "nth") return `BYDAY=${rule.which === "first" ? 1 : -1}${BYDAY[rule.weekday - 1]}`;
  if (rule.day <= 28) return `BYMONTHDAY=${rule.day}`;
  // Day 29-31 falls back to the month's last day, like the ritual engine.
  const candidates = Array.from({ length: rule.day - 27 }, (_, index) => 28 + index).join(",");
  return `BYMONTHDAY=${candidates};BYSETPOS=-1`;
}

/**
 * An iCalendar feed with one recurring event per scheduled ritual, so the rhythm shows up in any
 * calendar app. It carries ritual names and times only, never note content.
 */
export function ritualCalendar(method: Record<string, unknown>, options: { timeZone: string; vaultId: string; today: string; now: Date; locale?: "en" | "tr" }): string {
  const titles = TITLES[options.locale ?? "en"];
  const stamp = options.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Life Kernel//Rituals//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${escapeText(`Life Kernel (${options.vaultId})`)}`, `X-WR-TIMEZONE:${options.timeZone}`];
  for (const ritual of RITUALS) {
    let time: string | null;
    let rrule: string;
    let start: string;
    try {
      time = parseTime(method[ritual.timeKey]);
      if (!time) continue;
      if (ritual.kind === "daily") {
        const days = parseDays(method[ritual.daysKey]);
        rrule = days.size === 7 ? "FREQ=DAILY" : `FREQ=WEEKLY;BYDAY=${[...days].sort().map((day) => BYDAY[day - 1]).join(",")}`;
        start = options.today;
        while (!days.has(weekday(start))) start = addDays(start, 1);
      } else {
        const rule = parseDayRule(method[ritual.dayKey], ritual.period);
        rrule = ritual.period === "week" ? `FREQ=WEEKLY;${dayPart(rule)}` : ritual.period === "month" ? `FREQ=MONTHLY;${dayPart(rule)}` : `FREQ=YEARLY;BYMONTH=3,6,9,12;${dayPart(rule)}`;
        // DTSTART must itself be an occurrence of the rule: the first scheduled date on or after today.
        let probe = options.today;
        start = scheduledDate(rule, ritual.period, probe);
        while (start < options.today) {
          probe = addDays(probe, ritual.period === "week" ? 7 : 28);
          start = scheduledDate(rule, ritual.period, probe);
        }
      }
    } catch {
      continue; // A malformed schedule is reported by ritual_status; the feed just leaves it out.
    }
    const local = `${start.replace(/-/g, "")}T${time.replace(":", "")}00`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ritual.id}@${options.vaultId}.lifekernel`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${options.timeZone}:${local}`,
      `DURATION:PT${MINUTES[ritual.id]}M`,
      `RRULE:${rrule}`,
      `SUMMARY:${escapeText(titles[ritual.id])}`,
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0M", `DESCRIPTION:${escapeText(titles[ritual.id])}`, "END:VALARM",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
