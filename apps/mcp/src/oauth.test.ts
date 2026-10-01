import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LifeKernel, type LifeKernelConfig } from "@lifekernel/core";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { validatePublicUrl } from "./oauth.js";

const staticToken = "static-token-with-at-least-24-chars";
const ownerSecret = "owner-secret-with-plenty-of-length";
const callback = "https://claude.ai/api/mcp/auth_callback";

async function start() {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-oauth-"));
  const vault = join(root, "vault");
  await mkdir(vault);
  await writeFile(join(vault, "note.md"), "---\nid: n\ntype: note\nstatus: active\narea: a\nprivacy: personal\nai_access: context\n---\n\n# Note\n", "utf8");
  const config: LifeKernelConfig = { version: 1, stateDir: join(root, "state"), timezone: "UTC", vaults: [{ id: "test", kind: "personal", path: vault, mode: "read-write", routes: { session: { folder: "sessions", type: "session", status: "active", area: "x", policy: "auto" } } }] };
  const kernel = new LifeKernel(config);
  const app = createHttpApp(kernel, { token: staticToken, oauth: { publicUrl: new URL("http://localhost"), ownerSecret, stateDir: config.stateDir } });
  const server = await new Promise<import("node:http").Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const form = (body: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString(), redirect: "manual" as const });

  async function register(redirect = callback) {
    return fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "Claude" }) });
  }

  async function connect(options: { write: boolean; secret?: string; deny?: boolean }) {
    const client = await (await register()).json() as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${base}/mcp`.replace(/^http:\/\/127\.0\.0\.1:\d+/, "http://localhost") });
    const page = await (await fetch(`${base}/authorize?${params}`)).text();
    const request = page.match(/name="request" value="([^"]+)"/)![1]!;
    const consent = await fetch(`${base}/oauth/consent`, form({ request, decision: options.deny ? "deny" : "approve", secret: options.secret ?? ownerSecret, ...(options.write ? { write: "1" } : {}) }));
    return { client, verifier, page, request, consent, params };
  }

  async function tokens(flow: Awaited<ReturnType<typeof connect>>, verifier = flow.verifier) {
    const code = new URL(flow.consent.headers.get("location")!).searchParams.get("code")!;
    const response = await fetch(`${base}/token`, form({ grant_type: "authorization_code", code, redirect_uri: callback, client_id: flow.client.client_id, code_verifier: verifier, resource: "http://localhost/mcp" }));
    return { code, response, body: await response.json() as Record<string, string> };
  }

  return { base, root, kernel, form, register, connect, tokens, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("OAuth for remote connectors", () => {
  it("advertises discovery metadata and challenges unauthenticated MCP calls", async () => {
    const s = await start();
    try {
      const challenge = await fetch(`${s.base}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify(initialize) });
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toMatch(/resource_metadata="[^"]*oauth-protected-resource\/mcp"/);
      const resource = await (await fetch(`${s.base}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string; authorization_servers: string[] };
      expect(resource.resource).toBe("http://localhost/mcp");
      expect(resource.authorization_servers).toEqual(["http://localhost/"]);
      const meta = await (await fetch(`${s.base}/.well-known/oauth-authorization-server`)).json() as { registration_endpoint: string; code_challenge_methods_supported: string[]; scopes_supported: string[] };
      expect(meta.registration_endpoint).toMatch(/\/register$/);
      expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
      expect(meta.scopes_supported).toEqual(["lifekernel:read", "lifekernel:write"]);
    } finally { await s.close(); }
  });

  it("registers clients but rejects insecure redirect URIs", async () => {
    const s = await start();
    try {
      expect((await s.register()).status).toBe(201);
      expect((await s.register("http://evil.example/cb")).status).toBe(400);
      expect((await s.register("javascript:alert(1)")).status).toBe(400);
    } finally { await s.close(); }
  });

  it("completes authorization code + PKCE and lets the token call MCP and REST", async () => {
    const s = await start();
    try {
      const flow = await s.connect({ write: true });
      expect(flow.page).toContain("Connect Claude to Life Kernel?");
      expect(flow.page).toContain("claude.ai");
      expect(flow.consent.status).toBe(302);
      const location = new URL(flow.consent.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(callback);
      expect(location.searchParams.get("state")).toBe("xyz");

      const wrong = await s.tokens(flow, "not-the-verifier-not-the-verifier-not-the-verifier");
      expect(wrong.response.status).toBe(400);
      const { body, code } = await s.tokens(flow);
      expect(body.token_type).toBe("Bearer");
      expect(body.scope).toBe("lifekernel:read lifekernel:write");

      expect((await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...mcpHeaders, ...bearer(body.access_token!) }, body: JSON.stringify(initialize) })).status).toBe(200);
      expect((await fetch(`${s.base}/v1/vaults`, { headers: bearer(body.access_token!) })).status).toBe(200);
      expect((await fetch(`${s.base}/v1/writes/preview`, { method: "POST", headers: { ...bearer(body.access_token!), "content-type": "application/json" }, body: "{}" })).status).toBe(400);

      const replay = await fetch(`${s.base}/token`, s.form({ grant_type: "authorization_code", code, redirect_uri: callback, client_id: flow.client.client_id, code_verifier: flow.verifier }));
      expect(replay.status).toBe(400);
    } finally { await s.close(); }
  });

  it("issues read-only tokens when the owner unchecks writing", async () => {
    const s = await start();
    try {
      const { body } = await s.tokens(await s.connect({ write: false }));
      expect(body.scope).toBe("lifekernel:read");
      expect((await fetch(`${s.base}/v1/vaults`, { headers: bearer(body.access_token!) })).status).toBe(200);
      const denied = await fetch(`${s.base}/v1/writes/apply`, { method: "POST", headers: { ...bearer(body.access_token!), "content-type": "application/json" }, body: "{}" });
      expect(denied.status).toBe(403);
    } finally { await s.close(); }
  });

  it("rejects a wrong owner secret, locks out after repeated failures, and issues no code", async () => {
    const s = await start();
    try {
      const first = await s.connect({ write: true, secret: "wrong-wrong-wrong-wrong-wrong" });
      expect(first.consent.status).toBe(401);
      expect(first.consent.headers.get("location")).toBeNull();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await fetch(`${s.base}/oauth/consent`, s.form({ request: first.request, decision: "approve", secret: "wrong-wrong-wrong-wrong-wrong" }));
      }
      const locked = await fetch(`${s.base}/oauth/consent`, s.form({ request: first.request, decision: "approve", secret: ownerSecret }));
      expect(locked.status).toBe(429);
      const audit = await readFile(join(s.root, "state/audit.jsonl"), "utf8");
      expect(audit).toContain("oauth_login_failed");
      expect(audit).not.toContain(ownerSecret);
    } finally { await s.close(); }
  });

  it("returns access_denied when the owner denies", async () => {
    const s = await start();
    try {
      const { consent } = await s.connect({ write: true, deny: true });
      const location = new URL(consent.headers.get("location")!);
      expect(location.searchParams.get("error")).toBe("access_denied");
      expect(location.searchParams.get("state")).toBe("xyz");
      expect(location.searchParams.get("code")).toBeNull();
    } finally { await s.close(); }
  });

  it("rotates refresh tokens and revokes access", async () => {
    const s = await start();
    try {
      const flow = await s.connect({ write: true });
      const { body } = await s.tokens(flow);
      const refresh = (token: string) => fetch(`${s.base}/token`, s.form({ grant_type: "refresh_token", refresh_token: token, client_id: flow.client.client_id }));
      const rotated = await refresh(body.refresh_token!);
      expect(rotated.status).toBe(200);
      const next = await rotated.json() as Record<string, string>;
      expect(next.refresh_token).not.toBe(body.refresh_token);
      expect((await refresh(body.refresh_token!)).status).toBe(400);

      await fetch(`${s.base}/revoke`, s.form({ token: next.access_token!, client_id: flow.client.client_id }));
      expect((await fetch(`${s.base}/v1/vaults`, { headers: bearer(next.access_token!) })).status).toBe(401);
      const stored = await readFile(join(s.root, "state/oauth.json"), "utf8");
      expect(stored).not.toContain(next.refresh_token!);
      expect(stored).not.toContain(body.access_token!);
    } finally { await s.close(); }
  });

  it("keeps the static token working alongside OAuth and rejects unknown tokens", async () => {
    const s = await start();
    try {
      expect((await fetch(`${s.base}/v1/vaults`, { headers: bearer(staticToken) })).status).toBe(200);
      expect((await fetch(`${s.base}/v1/vaults`, { headers: bearer("lka_not-a-real-token") })).status).toBe(401);
    } finally { await s.close(); }
  });

  it("binds an MCP session to the client that created it", async () => {
    const s = await start();
    try {
      const a = (await s.tokens(await s.connect({ write: true }))).body.access_token!;
      const b = (await s.tokens(await s.connect({ write: true }))).body.access_token!;
      const init = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...mcpHeaders, ...bearer(a) }, body: JSON.stringify(initialize) });
      const session = init.headers.get("mcp-session-id")!;
      const stolen = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...mcpHeaders, ...bearer(b), "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
      expect(stolen.status).toBe(403);
    } finally { await s.close(); }
  });
});

describe("real MCP client over HTTP with an OAuth token", () => {
  async function client(base: string, accessToken: string) {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: bearer(accessToken) } }));
    return c;
  }
  const request = { requestId: "remote-0001", vaultId: "test", operation: "create", route: "session", title: "Remote", body: "Written over OAuth.", source: "test", sourceDate: "2026-09-30" };

  it("lets a write-scoped token read, preview, and apply", async () => {
    const s = await start();
    try {
      const flow = await s.connect({ write: true });
      const c = await client(s.base, (await s.tokens(flow)).body.access_token!);
      expect(c.getInstructions()).toMatch(/skill_get/);
      await c.callTool({ name: "write_preview", arguments: { request } });
      const applied = await c.callTool({ name: "write_apply", arguments: { request } });
      expect(applied.isError).toBeFalsy();
      const [event] = await s.kernel.recentAudit(1);
      expect(event).toMatchObject({ event: "write_applied", client: { id: flow.client.client_id, name: "t" } });
      await c.close();
    } finally { await s.close(); }
  });

  it("lets a read-only token search but blocks every write tool", async () => {
    const s = await start();
    try {
      const c = await client(s.base, (await s.tokens(await s.connect({ write: false }))).body.access_token!);
      const search = await c.callTool({ name: "vault_search", arguments: { query: "Note" } });
      expect(search.isError).toBeFalsy();
      for (const name of ["write_preview", "write_apply"]) {
        const result = await c.callTool({ name, arguments: { request } });
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/read-only/);
      }
      await c.close();
    } finally { await s.close(); }
  });
});

describe("public URL validation", () => {
  it("requires an https origin", () => {
    expect(validatePublicUrl("https://memory.example.com").origin).toBe("https://memory.example.com");
    expect(() => validatePublicUrl("http://memory.example.com")).toThrow(/https/);
    expect(() => validatePublicUrl("https://memory.example.com/app")).toThrow(/origin/);
    expect(validatePublicUrl("http://localhost:8787").hostname).toBe("localhost");
  });
});
