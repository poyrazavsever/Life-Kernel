import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFile, withFileLock } from "./files.js";

/** Which vaults a connection may read and write. A writable vault is always readable. */
export interface VaultGrants { read: string[]; write: string[] }

/**
 * Parse `startup:write,personal:read` (or `startup` for read and write). Every vault must exist, so a typo
 * fails loudly instead of silently granting nothing.
 */
export function parseVaultGrants(value: string, knownVaults: string[]): VaultGrants {
  const grants: VaultGrants = { read: [], write: [] };
  for (const part of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [id, level = "write"] = part.split(":").map((item) => item.trim());
    if (!knownVaults.includes(id!)) throw new Error(`Unknown vault in grant: ${id}. Known: ${knownVaults.join(", ")}.`);
    if (level !== "read" && level !== "write") throw new Error(`Grant ${part} must end in :read or :write.`);
    if (!grants.read.includes(id!)) grants.read.push(id!);
    if (level === "write" && !grants.write.includes(id!)) grants.write.push(id!);
  }
  if (grants.read.length === 0) throw new Error("Grant at least one vault, for example personal:read.");
  return grants;
}

/** OAuth-style scopes for vault grants: `vault:<id>:read` and `vault:<id>:write`. */
export function grantScopes(grants: VaultGrants): string[] {
  return [...grants.read.map((id) => `vault:${id}:read`), ...grants.write.map((id) => `vault:${id}:write`)];
}

/** The vault grants carried in scopes, or null when the scopes name no vault (access to every vault). */
export function grantsFromScopes(scopes: string[]): VaultGrants | null {
  const vaultScopes = scopes.map((scope) => /^vault:([a-z0-9][a-z0-9-_]*):(read|write)$/.exec(scope)).filter((match) => match !== null);
  if (vaultScopes.length === 0) return null;
  const grants: VaultGrants = { read: [], write: [] };
  for (const [, id, level] of vaultScopes) {
    if (!grants.read.includes(id!)) grants.read.push(id!);
    if (level === "write" && !grants.write.includes(id!)) grants.write.push(id!);
  }
  return grants;
}

// ---- named agent tokens ----

export interface AgentToken { name: string; hash: string; scopes: string[]; createdAt: string }

const tokensPath = (stateDir: string) => join(stateDir, "tokens.json");
const hashToken = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function readTokens(stateDir: string): Promise<AgentToken[]> {
  try { return (JSON.parse(await readFile(tokensPath(stateDir), "utf8")) as { tokens: AgentToken[] }).tokens; } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function changeTokens<T>(stateDir: string, change: (tokens: AgentToken[]) => T): Promise<T> {
  return withFileLock(join(stateDir, "locks", "tokens.lock"), "Another token change is running; try again.", async () => {
    const tokens = await readTokens(stateDir);
    const result = change(tokens);
    await replaceFile(tokensPath(stateDir), `${JSON.stringify({ tokens }, null, 2)}\n`);
    return result;
  });
}

/**
 * Create a bearer token for one agent. Only its SHA-256 hash is stored; the token is returned once.
 * `scopes` are the API scopes (for example lifekernel:read and lifekernel:write) plus any vault grants.
 */
export async function createAgentToken(stateDir: string, name: string, scopes: string[], at: Date = new Date()): Promise<{ name: string; token: string; scopes: string[] }> {
  if (!/^[a-z0-9][a-z0-9-_]{0,39}$/.test(name)) throw new Error("Token names use 1-40 lowercase letters, digits, - and _.");
  const token = `lk_${randomBytes(32).toString("base64url")}`;
  await changeTokens(stateDir, (tokens) => {
    if (tokens.some((existing) => existing.name === name)) throw new Error(`A token named ${name} exists; revoke it first.`);
    tokens.push({ name, hash: hashToken(token), scopes, createdAt: at.toISOString() });
  });
  return { name, token, scopes };
}

export async function listAgentTokens(stateDir: string) {
  return (await readTokens(stateDir)).map(({ name, scopes, createdAt }) => ({ name, scopes, createdAt }));
}

export async function revokeAgentToken(stateDir: string, name: string): Promise<boolean> {
  return changeTokens(stateDir, (tokens) => {
    const index = tokens.findIndex((existing) => existing.name === name);
    if (index >= 0) tokens.splice(index, 1);
    return index >= 0;
  });
}

/** The token record a presented bearer value belongs to, compared in constant time. */
export async function findAgentToken(stateDir: string, presented: string): Promise<AgentToken | null> {
  const candidate = Buffer.from(hashToken(presented), "hex");
  let match: AgentToken | null = null;
  for (const token of await readTokens(stateDir)) if (timingSafeEqual(candidate, Buffer.from(token.hash, "hex"))) match = token;
  return match;
}
