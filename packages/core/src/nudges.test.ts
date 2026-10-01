import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannel, desktopCommand, type Channel, type ChannelConfig, type ChannelDeps, type NudgeMessage } from "./channels.js";
import { ritualCalendar } from "./ics.js";
import { LifeKernel, type LifeKernelConfig, type RitualReport } from "./index.js";
import { decideNudges, loadNudgeState, NotificationsSchema, pauseNudges, skipRitual, snoozeRitual, tick } from "./nudges.js";

const report = (now: string, rituals: RitualReport["rituals"], quietHours: RitualReport["quietHours"] = null): RitualReport =>
  ({ vaultId: "v", now, date: now.slice(0, 10), timeZone: "Europe/Istanbul", quietHours, rituals });
const circleDue = { id: "daily-circle" as const, state: "due" as const };

describe("decideNudges", () => {
  const options = (at: string) => ({ now: new Date(at), followUpAfterMinutes: 90 });

  it("sends one reminder, then one follow-up after the delay, then nothing", () => {
    const at = "2026-10-01T21:40:00+03:00";
    expect(decideNudges(report(at, [circleDue]), { sent: {}, snoozed: {} }, options(at)).nudges).toEqual([{ ritual: "daily-circle", occurrence: "daily-circle:2026-10-01", kind: "reminder" }]);
    const reminded = { sent: { "daily-circle:2026-10-01": { reminder: "2026-10-01T18:40:00.000Z" } }, snoozed: {} };
    expect(decideNudges(report(at, [circleDue]), reminded, options("2026-10-01T19:00:00Z"))).toEqual({ nudges: [], held: [{ ritual: "daily-circle", reason: "already-sent" }] });
    expect(decideNudges(report(at, [circleDue]), reminded, options("2026-10-01T20:10:00Z")).nudges).toEqual([{ ritual: "daily-circle", occurrence: "daily-circle:2026-10-01", kind: "follow-up" }]);
    const both = { sent: { "daily-circle:2026-10-01": { reminder: "2026-10-01T18:40:00.000Z", followUp: "2026-10-01T20:10:00.000Z" } }, snoozed: {} };
    expect(decideNudges(report(at, [circleDue]), both, options("2026-10-01T20:40:00Z")).nudges).toEqual([]);
    expect(decideNudges(report(at, [circleDue]), reminded, { now: new Date("2026-10-01T23:00:00Z"), followUpAfterMinutes: 0 }).nudges).toEqual([]);
  });

  it("keys reviews by period and ignores rituals that are not open", () => {
    const at = "2026-10-04T20:30:00+03:00";
    const rituals = [{ id: "weekly-review" as const, state: "overdue" as const, period: "2026-W40" }, { id: "morning-plan" as const, state: "done" as const }, { id: "monthly-review" as const, state: "upcoming" as const }];
    expect(decideNudges(report(at, rituals), { sent: {}, snoozed: {} }, options(at)).nudges).toEqual([{ ritual: "weekly-review", occurrence: "weekly-review:2026-W40", kind: "reminder" }]);
  });

  it("holds reminders while paused, snoozed, or in quiet hours, including a range across midnight", () => {
    const late = "2026-10-01T23:30:00+03:00";
    const quiet = { start: "23:00", end: "08:00" };
    expect(decideNudges(report(late, [circleDue], quiet), { sent: {}, snoozed: {} }, options(late)).held).toEqual([{ ritual: "daily-circle", reason: "quiet-hours" }]);
    expect(decideNudges(report("2026-10-02T07:59:00+03:00", [circleDue], quiet), { sent: {}, snoozed: {} }, options(late)).held[0]?.reason).toBe("quiet-hours");
    expect(decideNudges(report("2026-10-02T08:00:00+03:00", [circleDue], quiet), { sent: {}, snoozed: {} }, options(late)).nudges).toHaveLength(1);
    const at = "2026-10-01T21:40:00+03:00";
    expect(decideNudges(report(at, [circleDue]), { sent: {}, snoozed: {}, pausedUntil: "2026-10-01" }, options(at)).held[0]?.reason).toBe("paused");
    expect(decideNudges(report(at, [circleDue]), { sent: {}, snoozed: {}, pausedUntil: "2026-09-30" }, options(at)).nudges).toHaveLength(1);
    expect(decideNudges(report(at, [circleDue]), { sent: {}, snoozed: { "daily-circle": "2026-10-01T19:00:00Z" } }, options("2026-10-01T18:45:00Z")).held[0]?.reason).toBe("snoozed");
    expect(decideNudges(report(at, [circleDue]), { sent: {}, snoozed: { "daily-circle": "2026-10-01T19:00:00Z" } }, options("2026-10-01T19:01:00Z")).nudges).toHaveLength(1);
  });
});

describe("channels", () => {
  const message: NudgeMessage = { ritual: "daily-circle", kind: "reminder", title: "Günlük değerlendirme", body: "Günü kapatmak için 10-20 dakika.", prompt: "Let's do the circle." };
  const config = (raw: Record<string, unknown>) => NotificationsSchema.parse({ channels: [raw] }).channels[0]!;

  async function server() {
    const requests: Array<{ url: string; headers: Record<string, unknown>; body: string }> = [];
    let status = 200;
    const http = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { requests.push({ url: req.url!, headers: req.headers, body }); res.statusCode = status; res.end(); });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    return { base, requests, fail: (code: number) => { status = code; }, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
  }
  const deps = (env: NodeJS.ProcessEnv, extra: Partial<ChannelDeps> = {}): ChannelDeps => ({ env, fetch: globalThis.fetch, run: async () => {}, platform: "linux", now: () => new Date("2026-10-01T18:40:00Z"), ...extra });

  it("publishes to ntfy as JSON so Turkish titles survive, with an optional click link and token", async () => {
    const s = await server();
    try {
      const channel = createChannel(config({ type: "ntfy", openUrl: "https://claude.ai/new?q={prompt}" }), deps({ LIFEKERNEL_NTFY_TOPIC: "lk-secret-topic", LIFEKERNEL_NTFY_URL: `${s.base}/`, LIFEKERNEL_NTFY_TOKEN: "tk" }));
      await channel.send(message);
      const [request] = s.requests;
      expect(JSON.parse(request!.body)).toEqual({ topic: "lk-secret-topic", title: "Günlük değerlendirme", message: "Günü kapatmak için 10-20 dakika.", tags: ["calendar"], click: "https://claude.ai/new?q=Let's%20do%20the%20circle." });
      expect(request!.headers.authorization).toBe("Bearer tk");
      s.fail(429);
      await expect(channel.send(message)).rejects.toThrow("ntfy returned HTTP 429.");
    } finally { await s.close(); }
  });

  it("explains missing settings and refuses plain-http servers that are not local", async () => {
    await expect(createChannel(config({ type: "ntfy" }), deps({})).send(message)).rejects.toThrow("Set LIFEKERNEL_NTFY_TOPIC to your ntfy topic.");
    await expect(createChannel(config({ type: "ntfy" }), deps({ LIFEKERNEL_NTFY_TOPIC: "t", LIFEKERNEL_NTFY_URL: "http://ntfy.example.com" })).send(message)).rejects.toThrow(/must use https/);
    expect(() => config({ type: "ntfy", openUrl: "javascript:alert(1)" })).toThrow(/openUrl must be https/);
  });

  it("signs webhook bodies with the timestamp", async () => {
    const s = await server();
    try {
      await createChannel(config({ type: "webhook" }), deps({ LIFEKERNEL_WEBHOOK_URL: `${s.base}/hook`, LIFEKERNEL_WEBHOOK_SECRET: "shh" })).send(message);
      const [request] = s.requests;
      const { createHmac } = await import("node:crypto");
      expect(request!.headers["x-lifekernel-timestamp"]).toBe("1790880000");
      expect(request!.headers["x-lifekernel-signature"]).toBe(`sha256=${createHmac("sha256", "shh").update(`1790880000.${request!.body}`).digest("hex")}`);
      expect(JSON.parse(request!.body)).toMatchObject({ event: "ritual_nudge", ritual: "daily-circle", kind: "reminder", prompt: "Let's do the circle." });
    } finally { await s.close(); }
  });

  it("passes desktop text only through the environment, never the command line or script", () => {
    const hostile = { ...message, title: "'; Remove-Item -Recurse C:\\ #", body: "$(rm -rf ~) <script>" };
    const windows = desktopCommand("win32", hostile, undefined, {});
    expect(windows.command).toBe("powershell.exe");
    expect(windows.args.join(" ")).not.toContain("Remove-Item");
    expect(windows.env).toMatchObject({ LK_TITLE: hostile.title, LK_BODY: hostile.body, LK_URL: "" });
    const mac = desktopCommand("darwin", hostile, undefined, {});
    expect(mac.args.join(" ")).not.toContain("rm -rf");
    expect(desktopCommand("linux", hostile, undefined, {}).args).toEqual(["--app-name=Life Kernel", hostile.title, hostile.body]);
  });
});

describe("tick", () => {
  const sent: NudgeMessage[] = [];
  const fake = (raw: Partial<ChannelConfig> = {}, fail = false): Channel => {
    const parsed = NotificationsSchema.parse({ channels: [{ type: "desktop", ...raw }] }).channels[0]!;
    return { type: "desktop", config: parsed, send: async (message) => { if (fail) throw new Error("offline"); sent.push(message); } };
  };

  async function setup(notifications: Record<string, unknown> = {}, rhythm = "") {
    sent.length = 0;
    const root = await mkdtemp(join(tmpdir(), "lifekernel-nudge-"));
    const vault = join(root, "vault");
    await mkdir(join(vault, "system"), { recursive: true });
    await mkdir(join(vault, "daily"));
    const fm = '---\nid: x\ntype: note\nstatus: active\narea: life\nprivacy: personal\nai_access: context\n';
    await writeFile(join(vault, "system/Method.md"), `${fm}daily_circle_time: "21:30"\n${rhythm}quiet_hours: "23:30-07:00"\n---\n\n# Method\n`, "utf8");
    await writeFile(join(vault, "daily/2026-09-29.md"), `${fm}circle: "done"\n---\n\n# Day\n`, "utf8");
    const config: LifeKernelConfig = {
      version: 1, stateDir: join(root, "state"), timezone: "Europe/Istanbul",
      vaults: [{ id: "personal", kind: "personal", path: vault, mode: "read-write", routes: { daily: { folder: "daily", type: "daily", status: "active", area: "life", policy: "auto", fields: ["circle", "morning_plan"] } } }],
      notifications: NotificationsSchema.parse({ channels: [{ type: "desktop" }], ...notifications })
    };
    return { root, vault, kernel: new LifeKernel(config) };
  }

  it("does nothing without a notifications section", async () => {
    const { kernel } = await setup();
    const bare = new LifeKernel({ ...kernel.config, notifications: undefined });
    await expect(tick(bare)).resolves.toMatchObject({ enabled: false, sent: [] });
  });

  it("sends the circle reminder once, a follow-up later, and remembers both across runs", async () => {
    const { kernel } = await setup();
    const channels = [fake()];
    const first = await tick(kernel, { at: new Date("2026-10-01T18:35:00Z"), channels });
    expect(first.sent).toEqual([{ ritual: "daily-circle", occurrence: "daily-circle:2026-10-01", kind: "reminder", channels: [{ type: "desktop", ok: true }] }]);
    expect(sent[0]).toMatchObject({ title: "Daily circle", body: "Ten to twenty minutes to close the day.", prompt: "Let's do the circle." });
    expect((await tick(kernel, { at: new Date("2026-10-01T18:50:00Z"), channels })).sent).toEqual([]);
    expect((await tick(kernel, { at: new Date("2026-10-01T20:05:00Z"), channels })).sent.map((nudge) => nudge.kind)).toEqual(["follow-up"]);
    expect((await tick(kernel, { at: new Date("2026-10-01T20:55:00Z"), channels })).sent).toEqual([]);
    expect(sent).toHaveLength(2);
    const events = (await kernel.recentAudit(10)).filter((event) => event.event === "nudge_sent");
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("close the day");
  });

  it("retries a reminder that reached no channel, and dry runs change nothing", async () => {
    const { kernel } = await setup();
    const failed = await tick(kernel, { at: new Date("2026-10-01T18:35:00Z"), channels: [fake({}, true)] });
    expect(failed.sent[0]!.channels).toEqual([{ type: "desktop", ok: false, error: "offline" }]);
    expect(await tick(kernel, { at: new Date("2026-10-01T18:40:00Z"), channels: [fake()], dryRun: true })).toMatchObject({ dryRun: true, sent: [{ kind: "reminder" }] });
    expect(sent).toHaveLength(0);
    expect((await tick(kernel, { at: new Date("2026-10-01T18:45:00Z"), channels: [fake()] })).sent).toHaveLength(1);
  });

  it("adds a catch-up line to the morning reminder after a missed circle, and agenda counts when asked", async () => {
    const { kernel, vault } = await setup({ locale: "tr", followUpAfterMinutes: 0 }, 'morning_plan_time: "08:30"\n');
    await writeFile(join(vault, "daily/2026-10-01.md"), '---\nid: d\ntype: daily\nstatus: active\narea: life\nprivacy: personal\nai_access: context\n---\n\n# Day\n\n## Plan for today\n\nShip it.\n', "utf8");
    await tick(kernel, { at: new Date("2026-10-01T05:40:00Z"), channels: [fake({ content: "agenda" })] });
    expect(sent[0]).toMatchObject({ title: "Sabah planı", prompt: "Günü planlayalım." });
    expect(sent[0]!.body.split("\n")).toEqual(["Bugünün odağını seçmek için beş dakika.", "Dünün değerlendirmesi kaydedilmedi; istersen iki dakikalık bir telafi yapabiliriz."]);
    sent.length = 0;
    await tick(kernel, { at: new Date("2026-10-01T18:35:00Z"), channels: [fake({ content: "agenda" }), fake({ rituals: ["morning-plan"] })] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Plan: Ship it.");
  });

  it("respects quiet hours, snoozes, and pauses", async () => {
    const { kernel } = await setup();
    expect((await tick(kernel, { at: new Date("2026-10-01T20:40:00Z"), channels: [fake()] })).held).toEqual([{ ritual: "daily-circle", reason: "quiet-hours" }]);
    await snoozeRitual(kernel, "daily-circle", 30, new Date("2026-10-01T18:30:00Z"));
    expect((await tick(kernel, { at: new Date("2026-10-01T18:40:00Z"), channels: [fake()] })).held[0]?.reason).toBe("snoozed");
    expect((await tick(kernel, { at: new Date("2026-10-01T19:05:00Z"), channels: [fake()] })).sent).toHaveLength(1);
    await pauseNudges(kernel, "2026-10-02", new Date("2026-10-01T19:10:00Z"));
    expect((await loadNudgeState(kernel)).pausedUntil).toBe("2026-10-02");
    expect((await tick(kernel, { at: new Date("2026-10-02T18:35:00Z"), channels: [fake()] })).held[0]?.reason).toBe("paused");
    await pauseNudges(kernel, null);
    expect((await tick(kernel, { at: new Date("2026-10-02T18:36:00Z"), channels: [fake()] })).sent).toHaveLength(1);
    await expect(snoozeRitual(kernel, "evening" as never, 10)).rejects.toThrow(/Unknown ritual/);
  });

  it("records a skip in the vault so the ritual stops being due", async () => {
    const { kernel, vault } = await setup();
    const at = new Date("2026-10-01T18:35:00Z");
    const skipping = new LifeKernel(kernel.config, { now: () => at });
    await skipRitual(skipping, "personal", "daily-circle", "travelling");
    const note = await readFile(join(vault, "daily/2026-10-01.md"), "utf8");
    expect(note).toContain('circle: "skipped"');
    expect(note).toContain("Skipped the daily circle: travelling");
    expect((await tick(skipping, { at, channels: [fake()] })).sent).toEqual([]);
    await expect(skipRitual(skipping, "personal", "morning-plan", "")).resolves.toHaveLength(1);
    expect(await readFile(join(vault, "daily/2026-10-01.md"), "utf8")).toContain('morning_plan: "skipped"');
  });
});

describe("ritualCalendar", () => {
  it("turns the schedule into recurring events with synchronized starts and no note content", () => {
    const method = { morning_plan_time: "08:30", morning_plan_days: "weekdays", daily_circle_time: "21:30", weekly_review_day: "sun", weekly_review_time: "20:00", monthly_review_day: "31", monthly_review_time: "19:00", quarterly_review_day: "last-sun", quarterly_review_time: "18:00", secret: "never" };
    const ics = ritualCalendar(method, { timeZone: "Europe/Istanbul", vaultId: "personal", today: "2026-10-03", now: new Date("2026-10-03T09:00:00Z"), locale: "tr" });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART;TZID=Europe/Istanbul:20261005T083000\r\nDURATION:PT10M\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\nSUMMARY:Sabah planı");
    expect(ics).toContain("DTSTART;TZID=Europe/Istanbul:20261003T213000\r\nDURATION:PT20M\r\nRRULE:FREQ=DAILY");
    expect(ics).toContain("DTSTART;TZID=Europe/Istanbul:20261004T200000\r\nDURATION:PT45M\r\nRRULE:FREQ=WEEKLY;BYDAY=SU");
    expect(ics).toContain("DTSTART;TZID=Europe/Istanbul:20261031T190000\r\nDURATION:PT45M\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1");
    expect(ics).toContain("DTSTART;TZID=Europe/Istanbul:20261227T180000\r\nDURATION:PT60M\r\nRRULE:FREQ=YEARLY;BYMONTH=3,6,9,12;BYDAY=-1SU");
    expect(ics).not.toContain("never");
    expect(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  });

  it("leaves out unscheduled and malformed rituals", () => {
    const ics = ritualCalendar({ daily_circle_time: "late" }, { timeZone: "UTC", vaultId: "v", today: "2026-10-01", now: new Date("2026-10-01T00:00:00Z") });
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});
