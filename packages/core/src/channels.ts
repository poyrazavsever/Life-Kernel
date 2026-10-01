import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { z } from "zod";
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
  z.object({ type: z.literal("webhook"), urlEnv: z.string().default("LIFEKERNEL_WEBHOOK_URL"), secretEnv: z.string().default("LIFEKERNEL_WEBHOOK_SECRET"), ...common })
]);
export type ChannelConfig = z.infer<typeof ChannelSchema>;

export interface NudgeMessage {
  ritual: RitualId | "test";
  kind: "reminder" | "follow-up" | "test";
  title: string;
  body: string;
  /** The phrase that starts the ritual in an AI client. Never contains note text. */
  prompt: string;
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
}

const defaultRun: ChannelDeps["run"] = (command, args, env) => new Promise((resolve, reject) => {
  execFile(command, args, { env, timeout: 15_000, windowsHide: true }, (error) => error ? reject(new Error(`${command} failed: ${error.message.split("\n")[0]}`)) : resolve());
});

export const defaultDeps = (): ChannelDeps => ({ env: process.env, fetch: globalThis.fetch, run: defaultRun, platform: process.platform, now: () => new Date() });

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
        const response = await deps.fetch(server, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ topic, title: message.title, message: message.body, tags: ["calendar"], ...(click ? { click } : {}) })
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
  return {
    type: "desktop", config,
    async send(message) {
      const { command, args, env } = desktopCommand(deps.platform, message, linkFor(config, message), deps.env);
      await deps.run(command, args, env);
    }
  };
}
