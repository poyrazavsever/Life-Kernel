const DAY_MS = 86_400_000;

function parts(at: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(values.find((part) => part.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetMinutes(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time occurs in a zone. A time skipped by a DST jump resolves to the hour after. */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall - offsetMinutes(new Date(wall), timeZone) * 60_000;
  instant = wall - offsetMinutes(new Date(instant), timeZone) * 60_000;
  return new Date(instant);
}

/** ISO 8601 with the zone's offset, for example 2026-10-01T21:30:00+03:00. */
export function isoInZone(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  const offset = offsetMinutes(at, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export function weekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
