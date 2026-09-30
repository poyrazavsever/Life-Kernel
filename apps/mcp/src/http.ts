import { LifeKernel, loadConfig } from "@lifekernel/core";
import { createHttpApp } from "./app.js";

const host = process.env.LIFEKERNEL_HOST ?? "127.0.0.1";
const port = Number(process.env.LIFEKERNEL_PORT ?? "8787");
const token = process.env.LIFEKERNEL_API_TOKEN;
if (!token) throw new Error("LIFEKERNEL_API_TOKEN must contain at least 24 characters.");
const origins = new Set((process.env.LIFEKERNEL_ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
const kernel = new LifeKernel(await loadConfig(process.env.LIFEKERNEL_CONFIG ?? "./lifekernel.config.json"));
const app = createHttpApp(kernel, { token, origins, host });
app.listen(port, host, () => process.stderr.write(`Life Kernel listening on http://${host}:${port}
`));
