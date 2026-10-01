import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LifeKernel } from "./index.js";
import { RITUAL_IDS, type RitualId } from "./rituals.js";

export const NUDGE_ACTIONS = ["snooze", "skip"] as const;
export type NudgeAction = (typeof NUDGE_ACTIONS)[number];

/** Links from a notification stay valid this long. */
const LINK_LIFETIME_S = 24 * 60 * 60;

/**
 * The key that signs action links: LIFEKERNEL_ACTION_SECRET, or a random key created once in the state
 * directory. Rotating it invalidates every link already sent.
 */
export async function actionSecret(kernel: Pick<LifeKernel, "config">, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.LIFEKERNEL_ACTION_SECRET) {
    if (env.LIFEKERNEL_ACTION_SECRET.length < 32) throw new Error("LIFEKERNEL_ACTION_SECRET must contain at least 32 characters.");
    return env.LIFEKERNEL_ACTION_SECRET;
  }
  const path = join(kernel.config.stateDir, "action-secret");
  try { return (await readFile(path, "utf8")).trim(); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString("hex");
  // Another process may create it first; whichever file exists wins.
  await writeFile(path, `${secret}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  return (await readFile(path, "utf8")).trim();
}

const signed = (fields: Record<string, string>) => ["ritual", "action", "occurrence", "expires", "nonce"].map((key) => `${key}=${fields[key] ?? ""}`).join("&");
const signature = (secret: string, fields: Record<string, string>) => createHmac("sha256", secret).update(signed(fields)).digest("base64url");

/** A single-use link that performs one action on one ritual occurrence. */
export function actionLink(baseUrl: string, secret: string, input: { ritual: RitualId; action: NudgeAction; occurrence: string; now: Date }): string {
  const fields: Record<string, string> = {
    ritual: input.ritual, action: input.action, occurrence: input.occurrence,
    expires: String(Math.floor(input.now.getTime() / 1000) + LINK_LIFETIME_S),
    nonce: randomBytes(12).toString("base64url")
  };
  const url = new URL("/v1/nudges/act", baseUrl);
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  url.searchParams.set("sig", signature(secret, fields));
  return url.toString();
}

export type VerifiedAction = { ritual: RitualId; action: NudgeAction; occurrence: string; nonce: string; expires: number };

/** Check a link's signature and expiry. Single use is enforced by the caller, which records the nonce. */
export function verifyAction(secret: string, query: Record<string, unknown>, now: Date): VerifiedAction {
  const field = (key: string) => typeof query[key] === "string" ? query[key] as string : "";
  const fields = Object.fromEntries(["ritual", "action", "occurrence", "expires", "nonce"].map((key) => [key, field(key)]));
  const given = Buffer.from(field("sig"));
  const expected = Buffer.from(signature(secret, fields));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("This link is not valid.");
  const expires = Number(fields.expires);
  if (!Number.isFinite(expires) || expires < now.getTime() / 1000) throw new Error("This link has expired.");
  if (!(RITUAL_IDS as readonly string[]).includes(fields.ritual!) || !(NUDGE_ACTIONS as readonly string[]).includes(fields.action!)) throw new Error("This link is not valid.");
  return { ritual: fields.ritual as RitualId, action: fields.action as NudgeAction, occurrence: fields.occurrence!, nonce: fields.nonce!, expires };
}
