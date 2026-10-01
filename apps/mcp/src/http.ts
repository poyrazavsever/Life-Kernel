import { LifeKernel, loadConfig, tick } from "@lifekernel/core";
import { createHttpApp } from "./app.js";
import { validatePublicUrl } from "./oauth.js";

const host = process.env.LIFEKERNEL_HOST ?? "127.0.0.1";
const port = Number(process.env.LIFEKERNEL_PORT ?? "8787");
const origins = new Set((process.env.LIFEKERNEL_ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
const kernel = new LifeKernel(await loadConfig(process.env.LIFEKERNEL_CONFIG ?? "./lifekernel.config.json"));

const publicUrl = process.env.LIFEKERNEL_PUBLIC_URL;
const ownerSecret = process.env.LIFEKERNEL_OWNER_SECRET;
if (Boolean(publicUrl) !== Boolean(ownerSecret)) throw new Error("Set both LIFEKERNEL_PUBLIC_URL and LIFEKERNEL_OWNER_SECRET to enable OAuth, or neither.");

const app = createHttpApp(kernel, {
  token: process.env.LIFEKERNEL_API_TOKEN || undefined,
  origins,
  host,
  oauth: publicUrl && ownerSecret ? { publicUrl: validatePublicUrl(publicUrl), ownerSecret, stateDir: kernel.config.stateDir } : undefined,
  calendarToken: process.env.LIFEKERNEL_CALENDAR_TOKEN || undefined
});

// In remote and Docker mode the server checks rituals itself; locally, `lifekernel schedule install` does.
if (process.env.LIFEKERNEL_SCHEDULER === "on") {
  const minutes = Number(process.env.LIFEKERNEL_TICK_MINUTES ?? "5");
  if (!(minutes >= 1 && minutes <= 60)) throw new Error("LIFEKERNEL_TICK_MINUTES must be between 1 and 60.");
  const check = () => tick(kernel).then((result) => {
    for (const nudge of result.sent) for (const channel of nudge.channels) if (!channel.ok) process.stderr.write(`Reminder ${nudge.ritual} on ${channel.type} failed: ${channel.error}\n`);
  }, (error: unknown) => process.stderr.write(`Reminder check failed: ${error instanceof Error ? error.message : String(error)}\n`));
  void check();
  setInterval(check, minutes * 60_000).unref();
}
app.listen(port, host, () => process.stderr.write(`Life Kernel listening on http://${host}:${port}${publicUrl ? ` (OAuth issuer ${publicUrl})` : ""}\n`));
