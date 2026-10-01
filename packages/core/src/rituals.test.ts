import { describe, expect, it } from "vitest";
import { evaluateRituals, parseQuietHours, type Outcome, type RitualContext } from "./rituals.js";
import { isoInZone, zonedInstant } from "./time.js";

const ZONE = "Europe/Istanbul";

function context(at: string, options: { daily?: Record<string, Outcome>; periods?: Record<string, Outcome>; firstActiveDate?: string | null } = {}): RitualContext {
  const now = new Date(at);
  return {
    now, timeZone: ZONE,
    today: new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(now),
    firstActiveDate: options.firstActiveDate === undefined ? "2026-09-01" : options.firstActiveDate,
    dailyOutcome: async (date) => options.daily?.[date] ?? null,
    periodOutcome: async (period, date) => options.periods?.[`${period}:${date}`] ?? null
  };
}

async function one(method: Record<string, unknown>, ctx: RitualContext, id: string) {
  return (await evaluateRituals(method, ctx)).find((status) => status.id === id)!;
}

describe("time zones", () => {
  it("turns wall-clock times into instants with the right offset, across DST", () => {
    expect(isoInZone(zonedInstant("2026-10-01", "21:30", ZONE), ZONE)).toBe("2026-10-01T21:30:00+03:00");
    expect(isoInZone(zonedInstant("2026-10-01", "21:30", "Europe/Berlin"), "Europe/Berlin")).toBe("2026-10-01T21:30:00+02:00");
    expect(isoInZone(zonedInstant("2026-11-01", "21:30", "Europe/Berlin"), "Europe/Berlin")).toBe("2026-11-01T21:30:00+01:00");
    expect(isoInZone(zonedInstant("2026-03-29", "02:30", "Europe/Berlin"), "Europe/Berlin")).toBe("2026-03-29T03:30:00+02:00");
  });
});

describe("daily rituals", () => {
  const circle = { daily_circle_time: "21:30" };

  it("is not scheduled without a time and reports a malformed one instead of throwing", async () => {
    expect(await one({}, context("2026-10-01T12:00:00Z"), "daily-circle")).toEqual({ id: "daily-circle", state: "not-scheduled" });
    expect(await one({ daily_circle_time: "9pm" }, context("2026-10-01T12:00:00Z"), "daily-circle")).toMatchObject({ state: "not-scheduled", error: expect.stringMatching(/HH:MM/) });
    expect(await one({ daily_circle_time: "21:30", daily_circle_days: "someday" }, context("2026-10-01T12:00:00Z"), "daily-circle")).toMatchObject({ error: expect.stringMatching(/not a weekday/) });
  });

  it("moves from upcoming to due to overdue, and stops at done", async () => {
    expect(await one(circle, context("2026-10-01T17:00:00Z"), "daily-circle")).toMatchObject({ state: "upcoming", dueAt: "2026-10-01T21:30:00+03:00", schedule: "21:30 every day" });
    expect(await one(circle, context("2026-10-01T18:45:00Z"), "daily-circle")).toMatchObject({ state: "due" });
    expect(await one(circle, context("2026-10-01T20:45:00Z"), "daily-circle")).toMatchObject({ state: "overdue" });
    expect(await one(circle, context("2026-10-01T20:45:00Z", { daily: { "2026-10-01": "done" } }), "daily-circle")).toMatchObject({ state: "done", lastDone: "2026-10-01" });
    expect(await one(circle, context("2026-10-01T20:45:00Z", { daily: { "2026-10-01": "skipped" } }), "daily-circle")).toMatchObject({ state: "skipped" });
  });

  it("counts the streak through skipped days and lists recently missed days", async () => {
    const daily: Record<string, Outcome> = { "2026-09-30": "done", "2026-09-29": "done", "2026-09-28": "skipped", "2026-09-27": "done", "2026-09-20": "done" };
    const status = await one(circle, context("2026-10-01T12:00:00Z", { daily }), "daily-circle");
    expect(status).toMatchObject({ streak: 3, lastDone: "2026-09-30", missed: ["2026-09-24", "2026-09-25", "2026-09-26"] });
  });

  it("does not count days before the vault was first used", async () => {
    const status = await one(circle, context("2026-10-01T12:00:00Z", { firstActiveDate: "2026-09-30", daily: { "2026-09-30": "done" } }), "daily-circle");
    expect(status).toMatchObject({ streak: 1 });
    expect(status.missed).toBeUndefined();
    expect((await one(circle, context("2026-10-01T12:00:00Z", { firstActiveDate: null }), "daily-circle")).missed).toBeUndefined();
  });

  it("points at the next scheduled day when today is off", async () => {
    const method = { morning_plan_time: "8:30", morning_plan_days: "mon-fri" };
    const saturday = await one(method, context("2026-10-03T06:00:00Z"), "morning-plan");
    expect(saturday).toMatchObject({ state: "upcoming", dueAt: "2026-10-05T08:30:00+03:00", schedule: "08:30 mon-fri" });
    const wrapping = await one({ morning_plan_time: "08:30", morning_plan_days: "sat-mon" }, context("2026-10-03T06:00:00Z"), "morning-plan");
    expect(wrapping).toMatchObject({ dueAt: "2026-10-03T08:30:00+03:00" });
  });
});

describe("review rituals", () => {
  it("schedules the weekly review in the current ISO week and reports the previous week if it was missed", async () => {
    const method = { weekly_review_day: "sun", weekly_review_time: "20:00" };
    expect(await one(method, context("2026-10-01T12:00:00Z"), "weekly-review")).toMatchObject({ state: "upcoming", dueAt: "2026-10-04T20:00:00+03:00", period: "2026-W40", missed: ["2026-W39"] });
    expect(await one(method, context("2026-10-04T18:00:00Z"), "weekly-review")).toMatchObject({ state: "due" });
    expect(await one(method, context("2026-10-04T18:00:00Z", { periods: { "week:2026-10-04": "done", "week:2026-09-27": "done" } }), "weekly-review")).toMatchObject({ state: "done", lastDone: "2026-W40" });
    expect(await one(method, context("2026-10-05T06:00:00Z", { periods: { "week:2026-10-04": "done" } }), "weekly-review")).toMatchObject({ state: "upcoming", period: "2026-W41", lastDone: "2026-W40" });
    expect((await one(method, context("2026-10-05T06:00:00Z"), "weekly-review")).missed).toEqual(["2026-W40"]);
  });

  it("counts a review as overdue after its day until the period ends", async () => {
    const method = { weekly_review_day: "mon", weekly_review_time: "09:00" };
    expect(await one(method, context("2026-10-01T12:00:00Z"), "weekly-review")).toMatchObject({ state: "overdue", dueAt: "2026-09-28T09:00:00+03:00" });
  });

  it("resolves monthly and quarterly days", async () => {
    const at = context("2026-10-01T12:00:00Z");
    expect(await one({ monthly_review_day: "last-sun", monthly_review_time: "19:00" }, at, "monthly-review")).toMatchObject({ dueAt: "2026-10-25T19:00:00+03:00", period: "2026-10" });
    expect(await one({ monthly_review_day: "first-thu", monthly_review_time: "19:00" }, at, "monthly-review")).toMatchObject({ dueAt: "2026-10-01T19:00:00+03:00", state: "upcoming" });
    expect(await one({ monthly_review_time: "19:00" }, at, "monthly-review")).toMatchObject({ dueAt: "2026-10-31T19:00:00+03:00", schedule: "last 19:00" });
    expect(await one({ quarterly_review_day: "15", quarterly_review_time: "10:00" }, at, "quarterly-review")).toMatchObject({ dueAt: "2026-12-15T10:00:00+03:00", period: "2026-Q4" });
    expect(await one({ monthly_review_day: "31", monthly_review_time: "10:00" }, context("2027-02-10T12:00:00Z"), "monthly-review")).toMatchObject({ dueAt: "2027-02-28T10:00:00+03:00" });
    expect(await one({ monthly_review_day: "sometime", monthly_review_time: "10:00" }, at, "monthly-review")).toMatchObject({ state: "not-scheduled", error: expect.stringMatching(/not a review day/) });
  });
});

describe("quiet hours", () => {
  it("parses a range and rejects anything else", () => {
    expect(parseQuietHours("23:00-8:00")).toEqual({ start: "23:00", end: "08:00" });
    expect(parseQuietHours("")).toBeNull();
    expect(() => parseQuietHours("late")).toThrow(/quiet-hours/);
  });
});
