/**
 * Checks that a remote Life Kernel server is reachable the way ChatGPT and Claude.ai reach it: over HTTPS,
 * with OAuth discovery, dynamic client registration, and a consent page. It only makes the requests those
 * clients make before a user signs in, so it needs no credentials and changes nothing but one throwaway
 * client registration per check run.
 */
export interface RemoteCheck { id: string; description: string; pass: boolean; detail?: string }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const CALLBACKS = [
  { client: "Claude.ai", uri: "https://claude.ai/api/mcp/auth_callback" },
  { client: "ChatGPT", uri: "https://chatgpt.com/connector_platform_oauth_redirect" }
];

const isLocal = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

export async function checkRemote(baseUrl: string, options: { fetch?: Fetch } = {}): Promise<RemoteCheck[]> {
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, { redirect: "manual", ...init }));
  const base = new URL(baseUrl);
  const origin = base.origin;
  const results: RemoteCheck[] = [];
  const record = (id: string, description: string, pass: boolean, detail?: string) => { results.push({ id, description, pass, ...(detail ? { detail } : {}) }); };
  const attempt = async <T>(id: string, description: string, work: () => Promise<{ pass: boolean; detail?: string; value?: T }>): Promise<T | undefined> => {
    try {
      const { pass, detail, value } = await work();
      record(id, description, pass, detail);
      return pass ? value : undefined;
    } catch (error: unknown) {
      record(id, description, false, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  record("https", "The server is reached over HTTPS", base.protocol === "https:" || isLocal(base), base.protocol === "https:" ? undefined : "ChatGPT and Claude.ai only connect over HTTPS");

  await attempt("health", "GET /health answers", async () => {
    const response = await doFetch(`${origin}/health`);
    return { pass: response.ok, detail: response.ok ? undefined : `HTTP ${response.status}` };
  });

  const mcpUrl = `${origin}/mcp`;
  const metadataUrl = await attempt<string>("challenge", "An unauthenticated call to /mcp gets a 401 that points to the resource metadata", async () => {
    const response = await doFetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const header = response.headers.get("www-authenticate") ?? "";
    const link = /resource_metadata="([^"]+)"/.exec(header)?.[1];
    return { pass: response.status === 401 && Boolean(link), detail: response.status !== 401 ? `HTTP ${response.status}, expected 401` : link ? undefined : "no resource_metadata in WWW-Authenticate (is OAuth enabled?)", value: link };
  });

  const resource = metadataUrl ? await attempt<{ resource: string; authorization_servers: string[] }>("resource-metadata", "The protected-resource metadata names this server and its authorization server", async () => {
    const response = await doFetch(metadataUrl);
    const body = await response.json() as { resource?: string; authorization_servers?: string[] };
    const sameOrigin = new URL(metadataUrl).origin === origin;
    const pass = response.ok && body.resource === mcpUrl && Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0 && sameOrigin;
    return { pass, detail: pass ? undefined : `resource=${body.resource ?? "missing"} (expected ${mcpUrl}), metadata served from ${new URL(metadataUrl).origin}`, value: body as { resource: string; authorization_servers: string[] } };
  }) : undefined;

  const issuer = resource?.authorization_servers[0];
  const server = issuer ? await attempt<Record<string, unknown>>("authorization-server", "The authorization server metadata supports code + PKCE S256, refresh tokens, and dynamic registration", async () => {
    const response = await doFetch(new URL("/.well-known/oauth-authorization-server", issuer).toString());
    const body = await response.json() as Record<string, unknown>;
    const has = (key: string, value: string) => Array.isArray(body[key]) && (body[key] as string[]).includes(value);
    const endpoints = ["authorization_endpoint", "token_endpoint", "registration_endpoint"].filter((key) => typeof body[key] !== "string" || new URL(body[key] as string).origin !== origin);
    const problems = [
      !response.ok && `HTTP ${response.status}`,
      endpoints.length > 0 && `endpoints missing or on another origin: ${endpoints.join(", ")}`,
      !has("code_challenge_methods_supported", "S256") && "no S256",
      !has("response_types_supported", "code") && "no response type code",
      !has("grant_types_supported", "authorization_code") && "no authorization_code grant",
      !has("grant_types_supported", "refresh_token") && "no refresh_token grant"
    ].filter(Boolean);
    return { pass: problems.length === 0, detail: problems.join("; ") || undefined, value: body };
  }) : undefined;

  const registration = typeof server?.registration_endpoint === "string" ? server.registration_endpoint : undefined;
  let authorize = typeof server?.authorization_endpoint === "string" ? server.authorization_endpoint : undefined;
  for (const { client, uri } of CALLBACKS) {
    if (!registration) { record(`register-${client}`, `${client} can register itself`, false, "no registration endpoint was found"); continue; }
    const clientId = await attempt<string>(`register-${client}`, `${client} can register itself with its callback URL`, async () => {
      const response = await doFetch(registration, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: `Life Kernel remote check (${client})`, redirect_uris: [uri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
      const body = await response.json().catch(() => ({})) as { client_id?: string; error_description?: string; error?: string };
      return { pass: response.status === 201 && Boolean(body.client_id), detail: response.status === 201 ? undefined : `HTTP ${response.status}: ${body.error_description ?? body.error ?? "no body"}`, value: body.client_id };
    });
    if (clientId && authorize && client === CALLBACKS[0]!.client) {
      const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // an arbitrary S256 challenge; the page is never submitted
      await attempt("consent-page", "The authorization endpoint shows the consent page, which cannot be framed", async () => {
        const url = new URL(authorize!);
        url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: uri, code_challenge: challenge, code_challenge_method: "S256", state: "check", resource: mcpUrl }).toString();
        const response = await doFetch(url.toString());
        const page = await response.text();
        const frame = response.headers.get("x-frame-options") ?? "";
        const problems = [
          !response.ok && `HTTP ${response.status}`,
          !/name="secret"/.test(page) && "no owner-secret field on the page",
          !/deny/i.test(frame) && "X-Frame-Options is not DENY"
        ].filter(Boolean);
        return { pass: problems.length === 0, detail: problems.join("; ") || undefined };
      });
      authorize = undefined;
    }
  }
  return results;
}
