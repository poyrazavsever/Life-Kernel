import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { capture } from "./capture.js";
import { defaultDeps, telegramCall, type ChannelConfig, type ChannelDeps } from "./channels.js";
import type { LifeKernel } from "./index.js";
import { applyNudgeAction, loadNudgeState, notificationsVault, skipRitual, snoozeRitual, updateState, type NotificationsConfig } from "./nudges.js";
import { RITUAL_IDS, type RitualId } from "./rituals.js";
import { formatRituals, formatToday, todaySummary } from "./today.js";

type TelegramConfig = Extract<ChannelConfig, { type: "telegram" }>;
type Locale = NotificationsConfig["locale"];

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

const REPLIES: Record<Locale, { captured: string; duplicate: string; snoozed: string; skipped: string; unknown: string; help: string; empty: string; failed: string }> = {
  en: {
    captured: "Added to the inbox.", duplicate: "Already in the inbox.", snoozed: "Snoozed for one hour.", skipped: "Skipped.",
    unknown: `Unknown ritual. Use one of: ${RITUAL_IDS.join(", ")}.`, empty: "Nothing to show yet.", failed: "That did not work; the server log has details.",
    help: "Send any message to add it to your inbox.\n/today: focus, tasks, and rituals\n/status: ritual states\n/snooze <ritual> [minutes]\n/skip <ritual> [reason]"
  },
  tr: {
    captured: "Inbox'a eklendi.", duplicate: "Zaten inbox'ta.", snoozed: "1 saat ertelendi.", skipped: "Atlandı.",
    unknown: `Bilinmeyen ritüel. Şunlardan biri: ${RITUAL_IDS.join(", ")}.`, empty: "Henüz gösterecek bir şey yok.", failed: "Olmadı; ayrıntılar sunucu kaydında.",
    help: "Inbox'a eklemek için herhangi bir mesaj gönder.\n/today: odak, işler ve ritüeller\n/status: ritüel durumları\n/snooze <ritüel> [dakika]\n/skip <ritüel> [neden]"
  }
};

function telegramChannel(kernel: LifeKernel): TelegramConfig | undefined {
  return kernel.config.notifications?.channels.find((channel): channel is TelegramConfig => channel.type === "telegram");
}

async function audit(kernel: LifeKernel, event: Record<string, unknown>): Promise<void> {
  await appendFile(join(kernel.config.stateDir, "audit.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

/** Recent chats that wrote to the bot, so the owner can find their chat ID. Does not consume updates. */
export async function telegramChats(kernel: LifeKernel, deps: ChannelDeps = defaultDeps()) {
  const channel = telegramChannel(kernel);
  if (!channel) throw new Error("Add a telegram channel under notifications first.");
  const updates = await telegramCall(deps, channel.tokenEnv, "getUpdates", { timeout: 0, allowed_updates: ["message"] }) as Array<{ message?: { chat: { id: number; type: string; username?: string; first_name?: string; title?: string } } }>;
  const chats = new Map<number, { id: number; type: string; name: string }>();
  for (const update of updates) {
    const chat = update.message?.chat;
    if (chat) chats.set(chat.id, { id: chat.id, type: chat.type, name: chat.title ?? chat.username ?? chat.first_name ?? "" });
  }
  return [...chats.values()];
}

/**
 * Read new messages and button presses from the owner's chat and act on them: plain text goes to the
 * inbox, commands answer or change reminders, and buttons snooze or skip. Anything from another chat is
 * ignored. Safe to run from several places: captures and skips are idempotent.
 */
export async function pollTelegram(kernel: LifeKernel, options: { deps?: ChannelDeps; timeoutSeconds?: number; at?: () => Date } = {}) {
  const channel = telegramChannel(kernel);
  if (!channel) return { enabled: false, handled: 0, ignored: 0 };
  const deps = options.deps ?? defaultDeps();
  const owner = deps.env[channel.chatEnv];
  if (!owner) throw new Error(`Set ${channel.chatEnv} to your Telegram chat ID (see lifekernel telegram setup).`);
  const locale = kernel.config.notifications!.locale;
  const replies = REPLIES[locale];
  const vaultId = notificationsVault(kernel);
  const now = options.at ?? (() => new Date());
  const state = await loadNudgeState(kernel);
  const updates = await telegramCall(deps, channel.tokenEnv, "getUpdates", { offset: state.telegramOffset ?? 0, timeout: options.timeoutSeconds ?? 0, allowed_updates: ["message", "callback_query"] }) as Update[];
  const send = (text: string) => telegramCall(deps, channel.tokenEnv, "sendMessage", { chat_id: owner, text });
  let handled = 0;
  let ignored = 0;
  let next = state.telegramOffset ?? 0;

  for (const update of updates) {
    next = Math.max(next, update.update_id + 1);
    const chat = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (String(chat) !== String(owner)) { ignored += 1; continue; }
    handled += 1;
    try {
      if (update.callback_query) {
        const [action, ritual] = (update.callback_query.data ?? "").split(":");
        const known = (action === "snooze" || action === "skip") && (RITUAL_IDS as readonly string[]).includes(ritual ?? "");
        if (known) await applyNudgeAction(kernel, ritual as RitualId, action, "telegram", now());
        await telegramCall(deps, channel.tokenEnv, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: known ? (action === "snooze" ? replies.snoozed : replies.skipped) : replies.unknown });
        await audit(kernel, { event: "nudge_action", ritual, action, via: "telegram", at: now().toISOString() });
        continue;
      }
      const text = update.message?.text?.trim() ?? "";
      if (!text) continue;
      const [command, first, ...rest] = text.split(/\s+/);
      if (command === "/start" || command === "/help") await send(replies.help);
      else if (command === "/today") await send(formatToday(await todaySummary(kernel, vaultId), locale));
      else if (command === "/status") await send(formatRituals((await kernel.ritualStatus(vaultId)).rituals, locale).join("\n") || replies.empty);
      else if (command === "/snooze" || command === "/skip") {
        if (!(RITUAL_IDS as readonly string[]).includes(first ?? "")) { await send(replies.unknown); continue; }
        if (command === "/snooze") await snoozeRitual(kernel, first as RitualId, Number(rest[0]) > 0 ? Number(rest[0]) : 60, now());
        else await skipRitual(kernel, vaultId, first as RitualId, rest.join(" "), { client: { name: "telegram" } });
        await send(command === "/snooze" ? replies.snoozed : replies.skipped);
      } else if (command!.startsWith("/")) await send(replies.help);
      else {
        const result = await capture(kernel, vaultId, text, { source: "telegram", requestId: `telegram-${update.update_id}`, at: now(), context: { client: { name: "telegram" } } });
        await send(result.duplicate ? replies.duplicate : replies.captured);
      }
    } catch (error: unknown) {
      await audit(kernel, { event: "telegram_failed", update: update.update_id, error: error instanceof Error ? error.message : String(error), at: now().toISOString() });
      await send(replies.failed).catch(() => undefined);
    }
  }
  if (next !== (state.telegramOffset ?? 0)) await updateState(kernel, now(), (current) => { current.telegramOffset = Math.max(current.telegramOffset ?? 0, next); });
  return { enabled: true, handled, ignored };
}
