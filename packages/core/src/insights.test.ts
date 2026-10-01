import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifeKernel, type LifeKernelConfig } from "./index.js";

// Sunday 2026-10-04, 20:00 UTC: the last day of ISO week 40 (Monday 09-28 to Sunday 10-04).
const NOW = new Date("2026-10-04T20:00:00Z");
const fm = (fields = "") => `---\nid: x\ntype: note\nstatus: active\narea: life\nprivacy: personal\nai_access: context\n${fields}---\n`;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-insights-"));
  const vault = join(root, "vault");
  const file = async (path: string, content: string) => { await mkdir(join(vault, dirname(path)), { recursive: true }); await writeFile(join(vault, path), content, "utf8"); };
  await file("system/Method.md", fm('daily_circle_time: "21:00"\nmorning_plan_time: "08:00"\nmorning_plan_days: "weekdays"\n') + "\n# Method\n");
  await file("schedule/Capacity.md", fm() + "\n# Capacity\n\n## Stated capacity\n\n- Focused work hours per weekday: 4\n- Focused work hours per weekend day: 2\n\n## Observed capacity\n");
  const day = (date: string, fields: string, body = "") => file(`daily/${date}.md`, fm(fields) + `\n# ${date}\n${body}`);
  await day("2026-09-21", "energy: 1\ncircle: \"done\"\n");
  await day("2026-09-28", "energy: 2\nfocus_hours: 1\ncircle: \"done\"\nmorning_plan: \"done\"\n", "\n## Plan for today\n\nDraft pricing page\n");
  await day("2026-09-29", "energy: 4\nfocus_hours: 3\ncircle: \"done\"\n", "\n## Plan for today\n\nDraft pricing page and email\n");
  await day("2026-09-30", "energy: 4\nfocus_hours: 4\ncircle: \"skipped\"\n");
  await day("2026-10-02", "energy: 3\nfocus_hours: 2\ncircle: \"done\"\n", "\n## Tomorrow's focus\n\ndraft PRICING page\n");
  await day("2026-10-03", "energy: 4\nfocus_hours: 0\ncircle: \"done\"\n");
  await file("projects/launch.md", fm().replace("type: note", "type: project") + "\n# Launch\n\n- [ ] Draft pricing page 📅 2026-10-01\n- [x] Domain ✅ 2026-09-29\n- [ ] Email\n");
  const config: LifeKernelConfig = {
    version: 1, stateDir: join(root, "state"), timezone: "UTC",
    vaults: [{ id: "personal", kind: "personal", path: vault, mode: "read-write", routes: {
      daily: { folder: "daily", type: "daily", status: "active", area: "life", policy: "auto" },
      review: { folder: "reviews", type: "weekly-review", status: "active", area: "life", policy: "auto", period: "week" }
    } }]
  };
  return new LifeKernel(config, { now: () => NOW });
}

describe("insights", () => {
  it("measures the week with evidence and leaves today out until it has an outcome", async () => {
    const kernel = await setup();
    const week = await kernel.insights("personal");
    expect(week.period).toEqual({ kind: "week", key: "2026-W40", start: "2026-09-28", end: "2026-10-04", through: "2026-10-04" });
    expect(week.days).toEqual({ total: 7, recorded: 5 });
    expect(week.energy).toMatchObject({ average: 3.4, samples: 5, lowest: [{ date: "2026-09-28", energy: 2 }], firstHalf: null, secondHalf: null });
    expect(week.focus).toMatchObject({ totalHours: 10, recordedDays: 5, averagePerRecordedDay: 2, stated: { weekday: 4, weekend: 2, source: "schedule/Capacity.md" }, statedForRecordedDays: 18, shareOfStated: 0.56 });
    expect(week.rituals.dailyCircle).toEqual({ scheduled: 6, done: 4, skipped: 1, missed: 1, doneRate: 0.67, missedDates: ["2026-10-01"] });
    expect(week.rituals.morningPlan).toMatchObject({ scheduled: 5, done: 1, missed: 4 });
    expect(week.tasks).toEqual({ completed: 1, overdue: 1, repeatedlyPlanned: [{ text: "Draft pricing page", path: "projects/launch.md", plannedOn: ["2026-09-28", "2026-09-29", "2026-10-02"] }] });
    expect(week.observations).toEqual([
      "Focus was 10 hours over 5 recorded days, 56% of the stated 18 hours for those days.",
      "Daily circle done on 4 of 6 scheduled days, skipped on 1, missing on 2026-10-01.",
      "Morning plan done on 1 of 5 scheduled days, missing on 2026-09-29, 2026-09-30, 2026-10-01, 2026-10-02.",
      "\"Draft pricing page\" (projects/launch.md) was in the plan on 2026-09-28, 2026-09-29, 2026-10-02 and is still open."
    ]);
  });

  it("names a weak weekday only when the samples support it", async () => {
    const kernel = await setup();
    const september = await kernel.insights("personal", { period: "month", date: "2026-09-15" });
    expect(september.period).toMatchObject({ key: "2026-09", through: "2026-09-30" });
    expect(september.energy.byWeekday.mon).toEqual({ average: 1.5, samples: 2 });
    expect(september.observations[0]).toBe("Energy averaged 1.5 on mon (2 days) against 2.8 overall (4 days).");
  });

  it("returns empty numbers for a future period and feeds the review agendas", async () => {
    const kernel = await setup();
    const future = await kernel.insights("personal", { date: "2026-12-01" });
    expect(future.days).toEqual({ total: 0, recorded: 0 });
    expect(future.observations).toEqual([]);
    const agenda = await kernel.ritualAgenda("personal", "weekly-review") as { insights: { period: { key: string }; observations: string[] } };
    expect(agenda.insights.period.key).toBe("2026-W40");
    expect(agenda.insights.observations).toHaveLength(4);
  });
});
