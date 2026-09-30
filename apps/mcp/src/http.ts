import { LifeKernel, loadConfig } from "@lifekernel/core";
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
  oauth: publicUrl && ownerSecret ? { publicUrl: validatePublicUrl(publicUrl), ownerSecret, stateDir: kernel.config.stateDir } : undefined
});
app.listen(port, host, () => process.stderr.write(`Life Kernel listening on http://${host}:${port}${publicUrl ? ` (OAuth issuer ${publicUrl})` : ""}\n`));
