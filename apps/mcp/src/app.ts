import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { capture, findAgentToken, grantsFromScopes, notificationsVault, performLinkedAction, type LifeKernel } from "@lifekernel/core";
import { LifeKernelOAuth, type OAuthOptions } from "./oauth.js";
import { ALL_SCOPES, SCOPE_CAPTURE, SCOPE_READ, SCOPE_WRITE } from "./scopes.js";
import { createLifeKernelMcp } from "./server.js";
import { SessionRegistry, type SessionOptions } from "./sessions.js";
import { VERSION } from "./version.js";

export interface HttpAppOptions {
  /** Static bearer token for trusted clients such as Claude Code. Optional when OAuth is enabled. */
  token?: string;
  origins?: Set<string>;
  host?: string;
  /** Enables the OAuth 2.1 authorization server that ChatGPT and Claude.ai connectors need. */
  oauth?: OAuthOptions;
  /** Enables the read-only ritual calendar feed at /v1/rituals.ics?token=... */
  calendarToken?: string;
  /** A token that can only add items to the inbox, for phone shortcuts and automations. */
  captureToken?: string;
  /** Idle timeout and upper bound for open MCP sessions. */
  sessions?: SessionOptions;
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createHttpApp(kernel: LifeKernel, options: HttpAppOptions) {
  const { token, origins = new Set<string>(), host = "127.0.0.1", oauth, calendarToken, captureToken } = options;
  if (captureToken !== undefined && (captureToken.length < 24 || captureToken === token || captureToken === calendarToken)) throw new Error("LIFEKERNEL_CAPTURE_TOKEN must contain at least 24 characters and differ from the other tokens.");
  if (token !== undefined && token.length < 24) throw new Error("LIFEKERNEL_API_TOKEN must contain at least 24 characters.");
  if (calendarToken !== undefined && calendarToken.length < 24) throw new Error("LIFEKERNEL_CALENDAR_TOKEN must contain at least 24 characters.");
  if (calendarToken !== undefined && calendarToken === token) throw new Error("LIFEKERNEL_CALENDAR_TOKEN must differ from LIFEKERNEL_API_TOKEN.");
  if (token === undefined && !oauth) throw new Error("Set LIFEKERNEL_API_TOKEN or configure OAuth (LIFEKERNEL_PUBLIC_URL and LIFEKERNEL_OWNER_SECRET).");

  const provider = oauth ? new LifeKernelOAuth({ vaults: kernel.config.vaults.map((vault) => vault.id), ...oauth }) : undefined;
  const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
  const app = createMcpExpressApp({ host, ...(oauth ? { allowedHosts: [oauth.publicUrl.hostname, ...loopbackHosts] } : {}) });
  if (oauth) app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, service: "lifekernel", version: VERSION }));

  // Calendar apps cannot send headers, so the feed takes its own token in the URL. It grants nothing
  // but ritual names and times, and it is separate from every token that can read or write notes.
  if (calendarToken !== undefined) {
    app.get("/v1/rituals.ics", async (req, res, next) => {
      const given = typeof req.query.token === "string" ? req.query.token : "";
      if (!safeEqual(given, calendarToken)) return void res.status(401).json({ error: "Invalid calendar token." });
      try {
        res.type("text/calendar; charset=utf-8").set("cache-control", "private, max-age=300").send(await kernel.ritualCalendar(notificationsVault(kernel)));
      } catch (e) { next(e); }
    });
  }

  const resourceMetadataUrl = provider ? getOAuthProtectedResourceMetadataUrl(provider.resourceUrl) : undefined;
  if (provider && oauth) {
    app.use(mcpAuthRouter({
      provider,
      issuerUrl: oauth.publicUrl,
      resourceServerUrl: provider.resourceUrl,
      scopesSupported: ALL_SCOPES,
      resourceName: "Life Kernel"
    }));
    app.post("/oauth/consent", express.urlencoded({ extended: false, limit: "4kb" }), (req, res, next) => { provider.consentHandler(req, res).catch(next); });
  }

  const verifier = {
    async verifyAccessToken(candidate: string): Promise<AuthInfo> {
      if (token !== undefined && safeEqual(candidate, token)) {
        return { token: candidate, clientId: "static-token", scopes: ALL_SCOPES, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      }
      if (captureToken !== undefined && safeEqual(candidate, captureToken)) {
        return { token: candidate, clientId: "capture-token", scopes: [SCOPE_CAPTURE], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      }
      // Named agent tokens from `lifekernel token create`, each with its own scopes and vault grants.
      const agent = await findAgentToken(kernel.config.stateDir, candidate);
      if (agent) return { token: candidate, clientId: `token:${agent.name}`, scopes: agent.scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      if (provider) return provider.verifyAccessToken(candidate);
      throw new InvalidTokenError("Invalid token.");
    }
  };
  const protect: RequestHandler[] = [
    (req, res, next) => {
      const origin = req.header("origin");
      if (origin && !origins.has(origin)) return void res.status(403).json({ error: "Origin is not allowed." });
      next();
    },
    requireBearerAuth({ verifier, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}) })
  ];
  const needs = (scope: string): RequestHandler => (req, res, next) => {
    if (!req.auth?.scopes.includes(scope)) return void res.status(403).json({ error: "insufficient_scope", error_description: `This connection lacks the ${scope} scope.` });
    next();
  };
  const read = [...protect, needs(SCOPE_READ)];
  const write = [...protect, needs(SCOPE_WRITE)];

  // Each request sees only the vaults its token was granted; a token without vault grants sees them all.
  const view = (req: Request): LifeKernel => {
    const grants = grantsFromScopes(req.auth?.scopes ?? []);
    return grants ? kernel.restrictTo(grants) : kernel;
  };

  // Capture needs the capture scope (the capture token) or full write access.
  const captureAccess: RequestHandler = (req, res, next) => {
    if (!req.auth?.scopes.some((scope) => scope === SCOPE_CAPTURE || scope === SCOPE_WRITE)) return void res.status(403).json({ error: "insufficient_scope", error_description: "This connection cannot add to the inbox." });
    next();
  };
  app.post("/v1/capture", ...protect, captureAccess, async (req, res, next) => {
    try {
      if (typeof req.body?.text !== "string") return void res.status(400).json({ error: "Send JSON with a text field." });
      const requestId = typeof req.body.requestId === "string" ? req.body.requestId : undefined;
      res.json(await capture(view(req), typeof req.body.vaultId === "string" ? req.body.vaultId : notificationsVault(kernel), req.body.text, { source: typeof req.body.source === "string" ? req.body.source : "api", ...(requestId ? { requestId } : {}), context: { client: { id: req.auth!.clientId } } }));
    } catch (e) { next(e); }
  });

  // Snooze and skip buttons in notifications. The signed, single-use link is the credential.
  app.post("/v1/nudges/act", async (req, res) => {
    try {
      const result = await performLinkedAction(kernel, req.query as Record<string, unknown>);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (error) {
      res.status(403).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/v1/vaults", ...read, (req, res) => res.json(view(req).listVaults()));
  app.post("/v1/search", ...read, async (req, res, next) => { try { res.json(await view(req).search(req.body.query, req.body.vaultId, req.body.limit, req.body.includeRestricted ?? false, { type: req.body.type, status: req.body.status })); } catch (e) { next(e); } });
  app.post("/v1/read", ...read, async (req, res, next) => { try { res.json(await view(req).readNote(req.body.vaultId, req.body.path, req.body.includeRestricted ?? false)); } catch (e) { next(e); } });
  app.post("/v1/daily", ...read, async (req, res, next) => { try { res.json(await view(req).dailyNote(req.body.vaultId, req.body.date, req.body.route)); } catch (e) { next(e); } });
  app.post("/v1/context", ...read, async (req, res, next) => { try { res.json(await view(req).contextBundle(req.body.vaultId, req.body)); } catch (e) { next(e); } });
  app.post("/v1/period", ...read, async (req, res, next) => { try { res.json(await view(req).periodNote(req.body.vaultId, { route: req.body.route, period: req.body.period, date: req.body.date })); } catch (e) { next(e); } });
  app.post("/v1/notes", ...read, async (req, res, next) => { try { res.json(await view(req).listNotes(req.body.vaultId, req.body)); } catch (e) { next(e); } });
  app.post("/v1/tasks", ...read, async (req, res, next) => { try { res.json(await view(req).openTasks(req.body ?? {})); } catch (e) { next(e); } });
  app.post("/v1/rituals/status", ...read, async (req, res, next) => { try { res.json(await view(req).ritualStatus(req.body.vaultId)); } catch (e) { next(e); } });
  app.post("/v1/rituals/agenda", ...read, async (req, res, next) => { try { res.json(await view(req).ritualAgenda(req.body.vaultId, req.body.ritual, { date: req.body.date })); } catch (e) { next(e); } });
  app.post("/v1/insights", ...read, async (req, res, next) => { try { res.json(await view(req).insights(req.body.vaultId, { period: req.body.period, date: req.body.date })); } catch (e) { next(e); } });
  app.post("/v1/backlinks", ...read, async (req, res, next) => { try { res.json(await view(req).backlinks(req.body.vaultId, req.body.path, req.body.includeRestricted ?? false, req.body.limit)); } catch (e) { next(e); } });
  app.post("/v1/validate", ...read, async (req, res, next) => { try { res.json(await view(req).validate(req.body?.vaultId)); } catch (e) { next(e); } });
  app.post("/v1/writes/preview", ...write, async (req, res, next) => { try { res.json(await view(req).previewWrite(req.body)); } catch (e) { next(e); } });
  app.post("/v1/writes/apply", ...write, async (req, res, next) => { try { res.json(await view(req).applyWrite(req.body, { client: { id: req.auth!.clientId } })); } catch (e) { next(e); } });

  // A session belongs to the client that initialized it; idle ones are closed and the table is bounded.
  const sessions = new SessionRegistry(options.sessions);
  app.all("/mcp", ...read, async (req: Request, res: Response) => {
    try {
      const clientId = req.auth!.clientId;
      const sessionId = req.header("mcp-session-id");
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing && existing.clientId !== clientId) return void res.status(403).json({ error: "This MCP session belongs to another client." });
      let transport = existing?.transport;
      if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { sessions.add(id, { transport: transport!, clientId }); }
        });
        transport.onclose = () => { if (transport?.sessionId) sessions.remove(transport.sessionId); };
        await createLifeKernelMcp(view(req)).connect(transport);
      }
      // An unknown session ID (expired or closed) is a 404, which tells the client to initialize again.
      if (!transport) return void (sessionId
        ? res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null })
        : res.status(400).json({ error: "Missing or invalid MCP session." }));
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(400).json({ error: error instanceof Error ? error.message : String(error) }));
  return app;
}
