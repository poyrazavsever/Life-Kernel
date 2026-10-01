import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ALL_SCOPES, SCOPE_READ, SCOPE_WRITE } from "./scopes.js";

export interface OAuthOptions {
  /** Origin the server is reachable at, for example https://memory.example.com. */
  publicUrl: URL;
  /** Secret the owner types on the consent page. Never leaves this process. */
  ownerSecret: string;
  stateDir: string;
  /** Vault IDs offered on the consent page; when the owner limits any, tokens carry vault grants. */
  vaults?: string[];
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  maxClients?: number;
  /** Injectable clock in milliseconds, for tests. */
  now?: () => number;
}

interface RefreshRecord { clientId: string; scopes: string[]; resource: string; expiresAt: number }
interface AccessRecord extends RefreshRecord {}
interface CodeRecord { clientId: string; challenge: string; redirectUri: string; scopes: string[]; resource: string; expiresAt: number }
interface PendingRecord { clientId: string; params: AuthorizationParams; expiresAt: number }
interface Persisted { clients: Record<string, OAuthClientInformationFull>; refresh: Record<string, RefreshRecord> }

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
const trimSlash = (value: string) => value.replace(/\/+$/, "");

function secretMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(expected).digest());
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function validatePublicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw new Error("LIFEKERNEL_PUBLIC_URL must use https (http is allowed only for localhost).");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("LIFEKERNEL_PUBLIC_URL must be an origin without a path, query, or fragment.");
  return url;
}

export class LifeKernelOAuth implements OAuthServerProvider {
  readonly resourceUrl: URL;
  private readonly now: () => number;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly maxClients: number;
  private readonly statePath: string;
  private state: Persisted | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly access = new Map<string, AccessRecord>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly pending = new Map<string, PendingRecord>();
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(private readonly options: OAuthOptions) {
    if (options.ownerSecret.length < 20) throw new Error("LIFEKERNEL_OWNER_SECRET must contain at least 20 characters.");
    this.resourceUrl = new URL("/mcp", options.publicUrl);
    this.now = options.now ?? Date.now;
    this.accessTtl = options.accessTtlSeconds ?? 3600;
    this.refreshTtl = options.refreshTtlSeconds ?? 60 * 60 * 24 * 30;
    this.maxClients = options.maxClients ?? 100;
    this.statePath = join(options.stateDir, "oauth.json");
  }

  // ---- persistence (clients and refresh-token hashes only) ----

  private async load(): Promise<Persisted> {
    if (this.state) return this.state;
    try { this.state = JSON.parse(await readFile(this.statePath, "utf8")) as Persisted; } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { clients: {}, refresh: {} };
    }
    return this.state;
  }

  private save(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temp = `${this.statePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.statePath);
    });
    return this.writeChain;
  }

  private async audit(event: string, detail: Record<string, unknown>): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true });
    await appendFile(join(this.options.stateDir, "audit.jsonl"), `${JSON.stringify({ event, at: new Date(this.now()).toISOString(), ...detail })}\n`, "utf8");
  }

  // ---- clients ----

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => (await this.load()).clients[clientId],
      registerClient: async (metadata) => {
        for (const uri of metadata.redirect_uris ?? []) {
          let url: URL;
          try { url = new URL(String(uri)); } catch { throw new InvalidClientMetadataError("redirect_uris must be absolute URLs."); }
          const allowed = url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
          if (!allowed || url.hash) throw new InvalidClientMetadataError("redirect_uris must be https (or http on localhost) without a fragment.");
        }
        const state = await this.load();
        const ids = Object.keys(state.clients);
        if (ids.length >= this.maxClients) {
          const oldest = ids.sort((a, b) => (state.clients[a]!.client_id_issued_at ?? 0) - (state.clients[b]!.client_id_issued_at ?? 0))[0]!;
          delete state.clients[oldest];
        }
        const client = { ...metadata, client_id: randomBytes(16).toString("hex"), client_id_issued_at: Math.floor(this.now() / 1000) } as OAuthClientInformationFull;
        state.clients[client.client_id] = client;
        await this.save();
        await this.audit("oauth_client_registered", { clientId: client.client_id, clientName: client.client_name ?? null });
        return client;
      }
    };
  }

  // ---- authorization (consent page) ----

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = randomBytes(24).toString("base64url");
    this.pending.set(id, { clientId: client.client_id, params, expiresAt: this.now() + 10 * 60 * 1000 });
    this.sweep();
    this.page(res, 200, this.consentHtml(id, client, params));
  }

  /** POST /oauth/consent handler; expects urlencoded fields request, decision, secret, write. */
  consentHandler = async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const record = body.request ? this.pending.get(body.request) : undefined;
    if (!record || !body.request || record.expiresAt < this.now()) {
      this.page(res, 400, this.messageHtml("This sign-in request expired. Start the connection again from your AI app."));
      return;
    }
    const client = (await this.load()).clients[record.clientId];
    if (!client) { this.page(res, 400, this.messageHtml("Unknown client.")); return; }

    if (body.decision === "deny") {
      this.pending.delete(body.request);
      await this.audit("oauth_denied", { clientId: client.client_id });
      this.redirectBack(res, record.params, { error: "access_denied" });
      return;
    }

    const ip = req.ip ?? "unknown";
    const failure = this.failures.get(ip);
    if (failure && failure.lockedUntil > this.now()) {
      this.page(res, 429, this.consentHtml(body.request, client, record.params, "Too many failed attempts. Try again later."));
      return;
    }
    if (typeof body.secret !== "string" || !secretMatches(body.secret, this.options.ownerSecret)) {
      const count = (failure?.count ?? 0) + 1;
      this.failures.set(ip, { count, lockedUntil: count >= 5 ? this.now() + 15 * 60 * 1000 : 0 });
      await this.audit("oauth_login_failed", { clientId: client.client_id });
      this.page(res, 401, this.consentHtml(body.request, client, record.params, "Wrong secret."));
      return;
    }
    this.failures.delete(ip);

    const requested = (record.params.scopes ?? []).filter((scope) => ALL_SCOPES.includes(scope));
    const base = requested.length ? requested : [...ALL_SCOPES];
    const scopes = body.write === "1" ? base : base.filter((scope) => scope !== SCOPE_WRITE);
    if (!scopes.includes(SCOPE_READ)) scopes.unshift(SCOPE_READ);
    // Per-vault choices: "full" follows the write checkbox, "read" is read-only, "none" hides the vault.
    // When every vault is "full" the token carries no vault grants and keeps seeing vaults added later.
    const vaults = this.options.vaults ?? [];
    const levels = vaults.map((id) => ({ id, level: ["read", "none"].includes(body[`vault_${id}`] ?? "") ? body[`vault_${id}`]! : "full" }));
    if (levels.some((vault) => vault.level !== "full")) {
      const granted = levels.filter((vault) => vault.level !== "none");
      if (granted.length === 0) { this.page(res, 400, this.consentHtml(body.request, client, record.params, "Allow at least one vault.")); return; }
      scopes.push(...granted.map((vault) => `vault:${vault.id}:read`));
      if (scopes.includes(SCOPE_WRITE)) scopes.push(...granted.filter((vault) => vault.level === "full").map((vault) => `vault:${vault.id}:write`));
    }
    const code = token("lkc_");
    this.codes.set(code, {
      clientId: client.client_id,
      challenge: record.params.codeChallenge,
      redirectUri: record.params.redirectUri,
      scopes,
      resource: trimSlash((record.params.resource ?? this.resourceUrl).href),
      expiresAt: this.now() + 5 * 60 * 1000
    });
    this.pending.delete(body.request);
    await this.audit("oauth_authorized", { clientId: client.client_id, scopes });
    this.redirectBack(res, record.params, { code });
  };

  private redirectBack(res: Response, params: AuthorizationParams, query: Record<string, string>): void {
    const target = new URL(params.redirectUri);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    if (params.state) target.searchParams.set("state", params.state);
    res.set("Cache-Control", "no-store").redirect(302, target.toString());
  }

  // ---- token endpoint ----

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAt < this.now()) throw new InvalidGrantError("Invalid or expired authorization code.");
    return record.challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    this.codes.delete(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAt < this.now()) throw new InvalidGrantError("Invalid or expired authorization code.");
    if (redirectUri && redirectUri !== record.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    if (resource && trimSlash(resource.href) !== record.resource) throw new InvalidGrantError("resource does not match the authorization request.");
    return this.issue(client.client_id, record.scopes, record.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const state = await this.load();
    const key = hash(refreshToken);
    const record = state.refresh[key];
    if (!record || record.clientId !== client.client_id || record.expiresAt < this.now()) throw new InvalidGrantError("Invalid or expired refresh token.");
    if (scopes?.some((scope) => !record.scopes.includes(scope))) throw new InvalidGrantError("Requested scope exceeds the original grant.");
    if (resource && trimSlash(resource.href) !== record.resource) throw new InvalidGrantError("resource does not match the original grant.");
    delete state.refresh[key];
    return this.issue(client.client_id, scopes?.length ? scopes : record.scopes, record.resource);
  }

  private async issue(clientId: string, scopes: string[], resource: string): Promise<OAuthTokens> {
    const accessToken = token("lka_");
    const refreshToken = token("lkr_");
    const now = this.now();
    this.access.set(hash(accessToken), { clientId, scopes, resource, expiresAt: now + this.accessTtl * 1000 });
    (await this.load()).refresh[hash(refreshToken)] = { clientId, scopes, resource, expiresAt: now + this.refreshTtl * 1000 };
    await this.save();
    return { access_token: accessToken, token_type: "Bearer", expires_in: this.accessTtl, refresh_token: refreshToken, scope: scopes.join(" ") };
  }

  async verifyAccessToken(value: string): Promise<AuthInfo> {
    const record = this.access.get(hash(value));
    if (!record || record.expiresAt < this.now()) throw new InvalidTokenError("Invalid or expired access token.");
    return { token: value, clientId: record.clientId, scopes: record.scopes, expiresAt: Math.floor(record.expiresAt / 1000), resource: new URL(record.resource) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = hash(request.token);
    const access = this.access.get(key);
    if (access?.clientId === client.client_id) this.access.delete(key);
    const state = await this.load();
    if (state.refresh[key]?.clientId === client.client_id) { delete state.refresh[key]; await this.save(); }
  }

  // ---- helpers ----

  private sweep(): void {
    const now = this.now();
    for (const [key, record] of this.pending) if (record.expiresAt < now) this.pending.delete(key);
    for (const [key, record] of this.codes) if (record.expiresAt < now) this.codes.delete(key);
    for (const [key, record] of this.access) if (record.expiresAt < now) this.access.delete(key);
  }

  private page(res: Response, status: number, html: string): void {
    res.status(status).set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
    }).send(html);
  }

  private shell(content: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Life Kernel</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#17191c}h1{font-size:1.3rem}code{background:#eef0f4;padding:.1rem .3rem;border-radius:4px}input[type=password]{width:100%;padding:.5rem;margin:.4rem 0 1rem;box-sizing:border-box}button{padding:.55rem 1rem;font-size:1rem;margin-right:.5rem}.err{color:#b00020}</style></head><body>${content}</body></html>`;
  }

  private messageHtml(message: string): string {
    return this.shell(`<h1>Life Kernel</h1><p>${escapeHtml(message)}</p>`);
  }

  private consentHtml(id: string, client: OAuthClientInformationFull, params: AuthorizationParams, error?: string): string {
    const name = escapeHtml(client.client_name ?? "An application");
    const host = escapeHtml(new URL(params.redirectUri).host);
    return this.shell(
      `<h1>Connect ${name} to Life Kernel?</h1>` +
      `<p>It will return to <code>${host}</code> and can read your notes that allow AI access. Only continue if you started this connection.</p>` +
      (error ? `<p class="err">${escapeHtml(error)}</p>` : "") +
      `<form method="post" action="/oauth/consent" autocomplete="off">` +
      `<input type="hidden" name="request" value="${escapeHtml(id)}">` +
      `<label><input type="checkbox" name="write" value="1" checked> Allow writing notes through routes</label>` +
      ((this.options.vaults ?? []).length > 1
        ? `<fieldset style="margin-top:1rem"><legend>Vaults</legend>` + (this.options.vaults ?? []).map((id) => `<label style="display:block">${escapeHtml(id)} <select name="vault_${escapeHtml(id)}"><option value="full">full access</option><option value="read">read only</option><option value="none">no access</option></select></label>`).join("") + `</fieldset>`
        : "") +
      `<label style="display:block;margin-top:1rem">Owner secret<input type="password" name="secret" required autocomplete="off"></label>` +
      `<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny" formnovalidate>Deny</button></form>`
    );
  }
}
