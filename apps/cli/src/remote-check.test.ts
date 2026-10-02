import { describe, expect, it } from "vitest";
import { checkRemote } from "./remote-check.js";

const ORIGIN = "https://memory.example.com";

interface Options { challenge?: boolean; resource?: string; s256?: boolean; refresh?: boolean; register?: number; frame?: string; secretField?: boolean }

/** A stand-in for the server's pre-sign-in behavior, with switches to break one thing at a time. */
function fakeServer(options: Options = {}) {
  const o = { challenge: true, resource: `${ORIGIN}/mcp`, s256: true, refresh: true, register: 201, frame: "DENY", secretField: true, ...options };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/mcp") {
      return o.challenge
        ? new Response("{}", { status: 401, headers: { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"` } })
        : new Response("{}", { status: 401 });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: o.resource, authorization_servers: [`${ORIGIN}/`] });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: `${ORIGIN}/`, authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/token`, registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ["code"], grant_types_supported: o.refresh ? ["authorization_code", "refresh_token"] : ["authorization_code"],
        code_challenge_methods_supported: o.s256 ? ["S256"] : ["plain"]
      });
    }
    if (url.pathname === "/register" && init?.method === "POST") return o.register === 201 ? json({ client_id: "abc123" }, 201) : json({ error: "invalid_client_metadata", error_description: "bad redirect" }, o.register);
    if (url.pathname === "/authorize") return new Response(o.secretField ? '<form><input name="secret" type="password"></form>' : "<p>hi</p>", { status: 200, headers: { "x-frame-options": o.frame } });
    return new Response("not found", { status: 404 });
  };
}

const failing = (results: Awaited<ReturnType<typeof checkRemote>>) => results.filter((result) => !result.pass).map((result) => result.id);

describe("checkRemote", () => {
  it("passes a server that behaves the way ChatGPT and Claude.ai need", async () => {
    const results = await checkRemote(ORIGIN, { fetch: fakeServer() });
    expect(failing(results)).toEqual([]);
    expect(results.map((result) => result.id)).toEqual(["https", "health", "challenge", "resource-metadata", "authorization-server", "register-Claude.ai", "consent-page", "register-ChatGPT"]);
  });

  it("flags plain HTTP on a public host", async () => {
    expect(failing(await checkRemote("http://memory.example.com", { fetch: fakeServer() }))).toContain("https");
    expect(failing(await checkRemote("http://localhost:8787", { fetch: fakeServer() }))).not.toContain("https");
  });

  it("flags a server without OAuth, whose 401 does not point to the metadata", async () => {
    const failed = failing(await checkRemote(ORIGIN, { fetch: fakeServer({ challenge: false }) }));
    expect(failed).toContain("challenge");
    expect(failed).not.toContain("authorization-server"); // nothing further can be checked, so those steps are skipped, not failed
  });

  it("flags metadata that names a different resource", async () => {
    expect(failing(await checkRemote(ORIGIN, { fetch: fakeServer({ resource: "https://other.example.com/mcp" }) }))).toContain("resource-metadata");
  });

  it("flags missing PKCE S256 or refresh tokens", async () => {
    expect(failing(await checkRemote(ORIGIN, { fetch: fakeServer({ s256: false }) }))).toContain("authorization-server");
    expect(failing(await checkRemote(ORIGIN, { fetch: fakeServer({ refresh: false }) }))).toContain("authorization-server");
  });

  it("flags a registration that is refused and a consent page that can be framed", async () => {
    expect(failing(await checkRemote(ORIGIN, { fetch: fakeServer({ register: 400 }) }))).toEqual(expect.arrayContaining(["register-Claude.ai", "register-ChatGPT"]));
    expect(failing(await checkRemote(ORIGIN, { fetch: fakeServer({ frame: "" }) }))).toContain("consent-page");
    expect(failing(await checkRemote(ORIGIN, { fetch: fakeServer({ secretField: false }) }))).toContain("consent-page");
  });

  it("reports an unreachable server instead of throwing", async () => {
    const results = await checkRemote(ORIGIN, { fetch: async () => { throw new Error("getaddrinfo ENOTFOUND memory.example.com"); } });
    expect(failing(results)).toEqual(expect.arrayContaining(["health", "challenge"]));
    expect(results.find((result) => result.id === "health")?.detail).toMatch(/ENOTFOUND/);
  });
});
