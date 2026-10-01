import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { createTransport } from "nodemailer";
import { z } from "zod";
import type { NudgeAction } from "./actions.js";
import { RITUAL_IDS, type RitualId } from "./rituals.js";

const OpenUrl = z.string().refine((value) => /^https:\/\//.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(value), "openUrl must be https, or http on localhost.");
const common = {
  /** `minimal` sends only the ritual's name; `agenda` adds counts and a short focus line from the vault. */
  content: z.enum(["minimal", "agenda"]).default("minimal"),
  /** A link opened from the notification. `{prompt}` becomes the ritual's starting phrase, URL-encoded. */
  openUrl: OpenUrl.optional(),
  /** Limit this channel to some rituals. */
  rituals: z.array(z.enum(RITUAL_IDS)).optional()
};

export const ChannelSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ntfy"), topicEnv: z.string().default("LIFEKERNEL_NTFY_TOPIC"), serverEnv: z.string().default("LIFEKERNEL_NTFY_URL"), tokenEnv: z.string().default("LIFEKERNEL_NTFY_TOKEN"), ...common }),
  z.object({ type: z.literal("desktop"), ...common }),
  z.object({ type: z.literal("webhook"), urlEnv: z.string().default("LIFEKERNEL_WEBHOOK_URL"), secretEnv: z.string().default("LIFEKERNEL_WEBHOOK_SECRET"), ...common }),
  z.object({ type: z.literal("telegram"), tokenEnv: z.string().default("LIFEKERNEL_TELEGRAM_TOKEN"), chatEnv: z.string().default("LIFEKERNEL_TELEGRAM_CHAT_ID"), ...common }),
  z.object({ type: z.literal("email"), smtpUrlEnv: z.string().default("LIFEKERNEL_SMTP_URL"), fromEnv: z.string().default("LIFEKERNEL_EMAIL_FROM"), toEnv: z.string().default("LIFEKERNEL_EMAIL_TO"), ...common })
]);
export type ChannelConfig = z.infer<typeof ChannelSchema>;

export interface NudgeMessage {
  ritual: RitualId | "test";
  kind: "reminder" | "follow-up" | "test";
  title: string;
  body: string;
  /** The phrase that starts the ritual in an AI client. Never contains note text. */
  prompt: string;
  /** Localized label for the button that opens `openUrl`. */
  startLabel?: string;
  /** Snooze and skip buttons. `url` is a signed single-use link; Telegram uses callbacks instead. */
  actions?: Array<{ action: NudgeAction; label: string; url?: string }>;
}

export interface Channel {
  type: ChannelConfig["type"];
  config: ChannelConfig;
  /** Deliver the message; throws with a message that never contains secrets. */
  send(message: NudgeMessage): Promise<void>;
}

export interface ChannelDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  run: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  platform: NodeJS.Platform;
  now: () => Date;
  sendMail: (smtpUrl: string, mail: { from: string; to: string; subject: string; text: string }) => Promise<void>;
}

const defaultRun: ChannelDeps["run"] = (command, args, env) => new Promise((resolve, reject) => {
  execFile(command, args, { env, timeout: 15_000, windowsHide: true }, (error) => error ? reject(new Error(`${command} failed: ${error.message.split("\n")[0]}`)) : resolve());
});

const defaultSendMail: ChannelDeps["sendMail"] = async (smtpUrl, mail) => {
  const url = new URL(smtpUrl);
  const secure = url.protocol === "smtps:";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  await createTransport({
    host: url.hostname,
    port: Number(url.port) || (secure ? 465 : 587),
    secure,
    // Credentials must not cross the network in the clear: smtps, or STARTTLS required on smtp.
    requireTLS: !secure && !local,
    ...(url.username ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } } : {})
  }).sendMail({ ...mail, disableFileAccess: true, disableUrlAccess: true });
};

export const defaultDeps = (): ChannelDeps => ({ env: process.env, fetch: globalThis.fetch, run: defaultRun, platform: process.platform, now: () => new Date(), sendMail: defaultSendMail });

export function linkFor(config: ChannelConfig, message: NudgeMessage): string | undefined {
  return config.openUrl?.replaceAll("{prompt}", encodeURIComponent(message.prompt));
}

function endpoint(raw: string, name: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} is not a valid URL.`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${name} must use https (http only on localhost).`);
  return url;
}

// Windows toast through the PowerShell app identity. Text arrives in environment variables and is added
// as XML text nodes, so nothing in a message can change the script or the toast's markup.
const WINDOWS_TOAST = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text></text><text></text></binding></visual></toast>')",
  "$texts = $xml.GetElementsByTagName('text')",
  "$texts.Item(0).AppendChild($xml.CreateTextNode($env:LK_TITLE)) | Out-Null",
  "$texts.Item(1).AppendChild($xml.CreateTextNode($env:LK_BODY)) | Out-Null",
  "if ($env:LK_URL) { $toast = $xml.SelectSingleNode('/toast'); $toast.SetAttribute('activationType', 'protocol'); $toast.SetAttribute('launch', $env:LK_URL) }",
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))"
].join("; ");

/** The command that shows a desktop notification on this platform. Text is passed only through the environment. */
export function desktopCommand(platform: NodeJS.Platform, message: NudgeMessage, url: string | undefined, env: NodeJS.ProcessEnv) {
  const textEnv = { ...env, LK_TITLE: message.title, LK_BODY: message.body, LK_URL: url ?? "" };
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_TOAST], env: textEnv };
  if (platform === "darwin") return { command: "osascript", args: ["-e", 'display notification (system attribute "LK_BODY") with title (system attribute "LK_TITLE")'], env: textEnv };
  return { command: "notify-send", args: ["--app-name=Life Kernel", message.title, message.body], env: textEnv };
}

export function createChannel(config: ChannelConfig, deps: ChannelDeps = defaultDeps()): Channel {
  if (config.type === "ntfy") {
    return {
      type: "ntfy", config,
      async send(message) {
        const topic = deps.env[config.topicEnv];
        if (!topic) throw new Error(`Set ${config.topicEnv} to your ntfy topic.`);
        const server = endpoint(deps.env[config.serverEnv] || "https://ntfy.sh", config.serverEnv);
        const token = deps.env[config.tokenEnv];
        const click = linkFor(config, message);
        // JSON publishing keeps non-ASCII titles intact, unlike ntfy's header form.
        const actions = (message.actions ?? []).filter((action) => action.url).map((action) => ({ action: "http", label: action.label, url: action.url, method: "POST", clear: true }));
        const response = await deps.fetch(server, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ topic, title: message.title, message: message.body, tags: ["calendar"], ...(click ? { click } : {}), ...(actions.length ? { actions } : {}) })
        });
        if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}.`);
      }
    };
  }
  if (config.type === "webhook") {
    return {
      type: "webhook", config,
      async send(message) {
        const raw = deps.env[config.urlEnv];
        if (!raw) throw new Error(`Set ${config.urlEnv} to the webhook URL.`);
        const url = endpoint(raw, config.urlEnv);
        const timestamp = Math.floor(deps.now().getTime() / 1000).toString();
        const link = linkFor(config, message);
        const body = JSON.stringify({ event: "ritual_nudge", ritual: message.ritual, kind: message.kind, title: message.title, body: message.body, prompt: message.prompt, ...(link ? { url: link } : {}), sentAt: deps.now().toISOString() });
        const secret = deps.env[config.secretEnv];
        // The signature covers the timestamp too, so a captured request cannot be replayed later as new.
        const headers: Record<string, string> = { "content-type": "application/json", "x-lifekernel-timestamp": timestamp };
        if (secret) headers["x-lifekernel-signature"] = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
        const response = await deps.fetch(url, { method: "POST", headers, body });
        if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}.`);
      }
    };
  }
  if (config.type === "telegram") {
    return {
      type: "telegram", config,
      async send(message) {
        const chat = deps.env[config.chatEnv];
        if (!chat) throw new Error(`Set ${config.chatEnv} to your Telegram chat ID (see lifekernel telegram setup).`);
        const link = linkFor(config, message);
        const rows = [
          ...(link ? [[{ text: message.startLabel ?? "Start", url: link }]] : []),
          ...(message.ritual !== "test" && message.actions?.length ? [message.actions.map((action) => ({ text: action.label, callback_data: `${action.action}:${message.ritual}` }))] : [])
        ];
        await telegramCall(deps, config.tokenEnv, "sendMessage", { chat_id: chat, text: `${message.title}\n${message.body}`, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
      }
    };
  }
  if (config.type === "email") {
    return {
      type: "email", config,
      async send(message) {
        const [smtpUrl, from, to] = [config.smtpUrlEnv, config.fromEnv, config.toEnv].map((name) => deps.env[name]);
        if (!smtpUrl || !from || !to) throw new Error(`Set ${config.smtpUrlEnv}, ${config.fromEnv}, and ${config.toEnv} for email.`);
        if (!/^smtps?:\/\//.test(smtpUrl)) throw new Error(`${config.smtpUrlEnv} must start with smtps:// or smtp://.`);
        const link = linkFor(config, message);
        try {
          await deps.sendMail(smtpUrl, { from, to, subject: message.title, text: `${message.body}${link ? `\n\n${link}` : ""}\n` });
        } catch (error: unknown) {
          // SMTP errors can echo the server URL, which holds the password; report the code only.
          const code = (error as { code?: string; responseCode?: number }).responseCode ?? (error as { code?: string }).code ?? "unknown";
          throw new Error(`Email delivery failed (${code}).`);
        }
      }
    };
  }
  return {
    type: "desktop", config,
    async send(message) {
      const { command, args, env } = desktopCommand(deps.platform, message, linkFor(config, message), deps.env);
      await deps.run(command, args, env);
    }
  };
}

/** Call the Telegram Bot API. Errors never include the bot token, which is part of the URL. */
export async function telegramCall(deps: Pick<ChannelDeps, "env" | "fetch">, tokenEnv: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  const token = deps.env[tokenEnv];
  if (!token) throw new Error(`Set ${tokenEnv} to your Telegram bot token.`);
  let response: Response;
  try {
    response = await deps.fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`Telegram ${method} could not be reached.`);
  }
  const payload = await response.json().catch(() => ({})) as { ok?: boolean; result?: unknown; description?: string };
  if (!response.ok || !payload.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}${payload.description ? `: ${payload.description.replaceAll(token, "<token>")}` : ""}.`);
  return payload.result;
}
