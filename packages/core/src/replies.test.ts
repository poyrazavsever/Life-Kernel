import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionLink, actionSecret, verifyAction } from "./actions.js";
import { createChannel, type ChannelDeps, type NudgeMessage } from "./channels.js";
import { LifeKernel, type LifeKernelConfig } from "./index.js";
import { loadNudgeState, NotificationsSchema, performLinkedAction, tick } from "./nudges.js";
import { pollTelegram, telegramChats } from "./telegram.js";
import { formatToday, todaySummary } from "./today.js";

const AT = new Date("2026-10-01T18:40:00Z"); // 21:40 in Istanbul

async function setup(notifications: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-replies-"));
  const vault = join(root, "vault");
  await mkdir(join(vault, "system"), { recursive: true });
  await mkdir(join(vault, "daily"));
  const fm = "---\nid: x\ntype: note\nstatus: active\narea: life\nprivacy: personal\nai_access: context\n";
  await writeFile(join(vault, "system/Method.md"), `${fm}daily_circle_time: "21:30"\n---\n\n# Method\n`, "utf8");
  await writeFile(join(vault, "daily/2026-10-01.md"), `${fm}---\n\n# Day\n\n## Plan for today\n\n- Ship the pricing page\n`, "utf8");
  const config: LifeKernelConfig = {
    version: 1, stateDir: join(root, "state"), timezone: "Europe/Istanbul",
    vaults: [{ id: "personal", kind: "personal", path: vault, mode: "read-write", routes: {
      daily: { folder: "daily", type: "daily", status: "active", area: "life", policy: "auto", fields: ["circle", "morning_plan"] },
      inbox: { folder: "inbox", type: "note", status: "inbox", area: "system", policy: "auto", period: "day", fields: ["status"] }
    } }],
    notifications: NotificationsSchema.parse({ channels: [{ type: "telegram" }], ...notifications })
  };
  return { root, vault, kernel: new LifeKernel(config, { now: () => AT }) };
}

/** A fake Telegram Bot API that serves queued updates and records every call. */
function fakeTelegram(updates: unknown[] = []) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const deps: ChannelDeps = {
    env: { LIFEKERNEL_TELEGRAM_TOKEN: "123:secret-token", LIFEKERNEL_TELEGRAM_CHAT_ID: "42" },
    fetch: (async (url: string, init: RequestInit) => {
      const method = url.split("/").pop()!;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ method, body });
      const result = method === "getUpdates" ? updates.filter((update) => (update as { update_id: number }).update_id >= Number(body.offset ?? 0)) : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }) as typeof fetch,
    run: async () => {}, platform: "linux", now: () => AT, sendMail: async () => {}
  };
  return { deps, calls, sent: () => calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text) };
}

describe("signed action links", () => {
  it("verify only with the right secret, before expiry, and for known rituals", async () => {
    const link = new URL(actionLink("https://memory.example.com", "s".repeat(64), { ritual: "daily-circle", action: "snooze", occurrence: "daily-circle:2026-10-01", now: AT }));
    expect(link.pathname).toBe("/v1/nudges/act");
    const query = Object.fromEntries(link.searchParams);
    expect(verifyAction("s".repeat(64), query, AT)).toMatchObject({ ritual: "daily-circle", action: "snooze", occurrence: "daily-circle:2026-10-01" });
    expect(() => verifyAction("t".repeat(64), query, AT)).toThrow(/not valid/);
    expect(() => verifyAction("s".repeat(64), { ...query, action: "skip" }, AT)).toThrow(/not valid/);
    expect(() => verifyAction("s".repeat(64), query, new Date(AT.getTime() + 25 * 3600_000))).toThrow(/expired/);
  });

  it("keep one generated secret per state directory, or use the configured one", async () => {
    const { kernel } = await setup();
    const first = await actionSecret(kernel, {});
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await actionSecret(kernel, {})).toBe(first);
    expect(await actionSecret(kernel, { LIFEKERNEL_ACTION_SECRET: "x".repeat(32) })).toBe("x".repeat(32));
    await expect(actionSecret(kernel, { LIFEKERNEL_ACTION_SECRET: "short" })).rejects.toThrow(/32 characters/);
  });

  it("snooze or skip once from a reminder, and refuse reuse or an earlier day's link", async () => {
    const { kernel, vault } = await setup();
    const secret = await actionSecret(kernel);
    const link = (action: "snooze" | "skip", occurrence = "daily-circle:2026-10-01") => Object.fromEntries(new URL(actionLink("https://m.example", secret, { ritual: "daily-circle", action, occurrence, now: AT })).searchParams);
    const snooze = link("snooze");
    await expect(performLinkedAction(kernel, snooze, AT)).resolves.toMatchObject({ ok: true, action: "snooze" });
    expect((await loadNudgeState(kernel)).snoozed["daily-circle"]).toBe("2026-10-01T19:40:00.000Z");
    await expect(performLinkedAction(kernel, snooze, AT)).rejects.toThrow(/already used/);
    await expect(performLinkedAction(kernel, link("skip", "daily-circle:2026-09-30"), AT)).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/earlier day/) });
    await expect(performLinkedAction(kernel, link("skip"), AT)).resolves.toMatchObject({ ok: true });
    expect(await readFile(join(vault, "daily/2026-10-01.md"), "utf8")).toContain('circle: "skipped"');
  });

  it("are attached to ntfy reminders when actionBaseUrl is set", async () => {
    const { kernel } = await setup({ actionBaseUrl: "https://memory.example.com", channels: [{ type: "ntfy" }] });
    const bodies: Array<Record<string, unknown>> = [];
    const deps: ChannelDeps = { env: { LIFEKERNEL_NTFY_TOPIC: "t" }, fetch: (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response("{}"); }) as typeof fetch, run: async () => {}, platform: "linux", now: () => AT, sendMail: async () => {} };
    await tick(kernel, { at: AT, deps });
    const actions = bodies[0]!.actions as Array<{ action: string; label: string; url: string; method: string }>;
    expect(actions.map((action) => [action.label, action.method])).toEqual([["Snooze 1h", "POST"], ["Skip", "POST"]]);
    expect(new URL(actions[0]!.url).searchParams.get("occurrence")).toBe("daily-circle:2026-10-01");
    expect(() => NotificationsSchema.parse({ actionBaseUrl: "http://memory.example.com" })).toThrow(/https/);
  });
});

describe("telegram", () => {
  const message = (id: number, text: string, chat = 42) => ({ update_id: id, message: { chat: { id: chat }, text } });

  it("sends reminders with start, snooze, and skip buttons", async () => {
    const { kernel } = await setup({ locale: "tr", channels: [{ type: "telegram", openUrl: "https://claude.ai/new?q={prompt}" }] });
    const telegram = fakeTelegram();
    await tick(kernel, { at: AT, deps: telegram.deps });
    const [call] = telegram.calls;
    expect(call).toMatchObject({ method: "sendMessage", body: { chat_id: "42", text: "Günlük değerlendirme\nGünü kapatmak için 10-20 dakika." } });
    expect((call!.body.reply_markup as { inline_keyboard: unknown }).inline_keyboard).toEqual([
      [{ text: "Başla", url: "https://claude.ai/new?q=G%C3%BCnl%C3%BCk%20de%C4%9Ferlendirmeyi%20yapal%C4%B1m." }],
      [{ text: "1 saat ertele", callback_data: "snooze:daily-circle" }, { text: "Atla", callback_data: "skip:daily-circle" }]
    ]);
  });

  it("captures the owner's messages, answers commands, ignores other chats, and never handles an update twice", async () => {
    const { kernel, vault } = await setup();
    const telegram = fakeTelegram([
      message(10, "Call the accountant"),
      message(11, "Not mine", 99),
      message(12, "/today"),
      message(13, "/snooze daily-circle 30"),
      message(14, "/skip evening")
    ]);
    await expect(pollTelegram(kernel, { deps: telegram.deps, at: () => AT })).resolves.toEqual({ enabled: true, handled: 4, ignored: 1 });
    expect(await readFile(join(vault, "inbox/2026-10-01.md"), "utf8")).toContain("- 21:40 Call the accountant (telegram)");
    const replies = telegram.sent();
    expect(replies[0]).toBe("Added to the inbox.");
    expect(replies[1]).toContain("Focus: Ship the pricing page");
    expect(replies[1]).toContain("1 item in the inbox");
    expect(replies.slice(2)).toEqual(["Snoozed for one hour.", expect.stringMatching(/^Unknown ritual/)]);
    expect((await loadNudgeState(kernel)).telegramOffset).toBe(15);
    expect(telegram.calls.filter((call) => call.method === "sendMessage").every((call) => call.body.chat_id === "42")).toBe(true);
    await pollTelegram(kernel, { deps: telegram.deps, at: () => AT });
    expect(telegram.sent()).toHaveLength(4);
  });

  it("handles button presses with a callback answer", async () => {
    const { kernel, vault } = await setup();
    const telegram = fakeTelegram([{ update_id: 20, callback_query: { id: "cb1", data: "skip:daily-circle", message: { chat: { id: 42 } } } }]);
    await pollTelegram(kernel, { deps: telegram.deps, at: () => AT });
    expect(telegram.calls.find((call) => call.method === "answerCallbackQuery")?.body).toEqual({ callback_query_id: "cb1", text: "Skipped." });
    expect(await readFile(join(vault, "daily/2026-10-01.md"), "utf8")).toContain('circle: "skipped"');
  });

  it("lists chats for setup and keeps the token out of errors", async () => {
    const { kernel } = await setup();
    const telegram = fakeTelegram([{ update_id: 1, message: { chat: { id: 42, type: "private", first_name: "Owner" }, text: "hi" } }]);
    await expect(telegramChats(kernel, telegram.deps)).resolves.toEqual([{ id: 42, type: "private", name: "Owner" }]);
    const failing: ChannelDeps = { ...telegram.deps, fetch: (async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized for bot123:secret-token" }), { status: 401 })) as typeof fetch };
    const error = await pollTelegram(kernel, { deps: failing }).catch((caught: Error) => caught);
    expect(String(error)).toContain("HTTP 401");
    expect(String(error)).not.toContain("secret-token");
  });
});

describe("email", () => {
  const message: NudgeMessage = { ritual: "weekly-review", kind: "reminder", title: "Weekly review", body: "Time to look back.", prompt: "Let's do the weekly review." };

  it("sends a plain-text mail with the link and hides SMTP details on failure", async () => {
    const config = NotificationsSchema.parse({ channels: [{ type: "email", openUrl: "https://claude.ai/new?q={prompt}" }] }).channels[0]!;
    const mails: unknown[] = [];
    const env = { LIFEKERNEL_SMTP_URL: "smtps://me:p%40ss@mail.example.com", LIFEKERNEL_EMAIL_FROM: "lk@example.com", LIFEKERNEL_EMAIL_TO: "me@example.com" };
    const deps = (sendMail: ChannelDeps["sendMail"]): ChannelDeps => ({ env, fetch: globalThis.fetch, run: async () => {}, platform: "linux", now: () => AT, sendMail });
    await createChannel(config, deps(async (url, mail) => { mails.push({ url, mail }); })).send(message);
    expect(mails).toEqual([{ url: env.LIFEKERNEL_SMTP_URL, mail: { from: "lk@example.com", to: "me@example.com", subject: "Weekly review", text: "Time to look back.\n\nhttps://claude.ai/new?q=Let's%20do%20the%20weekly%20review.\n" } }]);
    const failure = await createChannel(config, deps(async () => { throw Object.assign(new Error(`connect to ${env.LIFEKERNEL_SMTP_URL} failed`), { code: "ECONNREFUSED" }); })).send(message).catch((caught: Error) => caught);
    expect(String(failure)).toBe("Error: Email delivery failed (ECONNREFUSED).");
    await expect(createChannel(config, { ...deps(async () => {}), env: {} }).send(message)).rejects.toThrow(/Set LIFEKERNEL_SMTP_URL/);
  });
});

describe("today", () => {
  it("summarizes the focus, inbox, and rituals in either language", async () => {
    const { kernel } = await setup();
    const summary = await todaySummary(kernel, "personal");
    expect(summary).toMatchObject({ date: "2026-10-01", focus: { text: "Ship the pricing page", source: "daily/2026-10-01.md" }, inbox: 0 });
    expect(formatToday(summary, "en")).toBe("2026-10-01\nFocus: Ship the pricing page\n\nRituals:\n• Daily circle: due now (21:30)");
    expect(formatToday(summary, "tr")).toContain("• Günlük değerlendirme: zamanı geldi (21:30)");
  });
});
