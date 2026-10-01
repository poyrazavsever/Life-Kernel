import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { notificationsVault, type LifeKernel } from "@lifekernel/core";
import { LifeKernelOAuth, type OAuthOptions } from "./oauth.js";
import { ALL_SCOPES, SCOPE_READ, SCOPE_WRITE } from "./scopes.js";
import { createLifeKernelMcp } from "./server.js";
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
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createHttpApp(kernel: LifeKernel, options: HttpAppOptions) {
  const { token, origins = new Set<string>(), host = "127.0.0.1", oauth, calendarToken } = options;
  if (token !== undefined && token.length < 24) throw new Error("LIFEKERNEL_API_TOKEN must contain at least 24 characters.");
  if (calendarToken !== undefined && calendarToken.length < 24) throw new Error("LIFEKERNEL_CALENDAR_TOKEN must contain at least 24 characters.");
  if (calendarToken !== undefined && calendarToken === token) throw new Error("LIFEKERNEL_CALENDAR_TOKEN must differ from LIFEKERNEL_API_TOKEN.");
  if (token === undefined && !oauth) throw new Error("Set LIFEKERNEL_API_TOKEN or configure OAuth (LIFEKERNEL_PUBLIC_URL and LIFEKERNEL_OWNER_SECRET).");

  const provider = oauth ? new LifeKernelOAuth(oauth) : undefined;
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

  app.get("/v1/vaults", ...read, (_req, res) => res.json(kernel.listVaults()));
  app.post("/v1/search", ...read, async (req, res, next) => { try { res.json(await kernel.search(req.body.query, req.body.vaultId, req.body.limit, req.body.includeRestricted ?? false, { type: req.body.type, status: req.body.status })); } catch (e) { next(e); } });
  app.post("/v1/read", ...read, async (req, res, next) => { try { res.json(await kernel.readNote(req.body.vaultId, req.body.path, req.body.includeRestricted ?? false)); } catch (e) { next(e); } });
  app.post("/v1/daily", ...read, async (req, res, next) => { try { res.json(await kernel.dailyNote(req.body.vaultId, req.body.date, req.body.route)); } catch (e) { next(e); } });
  app.post("/v1/context", ...read, async (req, res, next) => { try { res.json(await kernel.contextBundle(req.body.vaultId, req.body)); } catch (e) { next(e); } });
  app.post("/v1/period", ...read, async (req, res, next) => { try { res.json(await kernel.periodNote(req.body.vaultId, { route: req.body.route, period: req.body.period, date: req.body.date })); } catch (e) { next(e); } });
  app.post("/v1/notes", ...read, async (req, res, next) => { try { res.json(await kernel.listNotes(req.body.vaultId, req.body)); } catch (e) { next(e); } });
  app.post("/v1/tasks", ...read, async (req, res, next) => { try { res.json(await kernel.openTasks(req.body ?? {})); } catch (e) { next(e); } });
  app.post("/v1/rituals/status", ...read, async (req, res, next) => { try { res.json(await kernel.ritualStatus(req.body.vaultId)); } catch (e) { next(e); } });
  app.post("/v1/rituals/agenda", ...read, async (req, res, next) => { try { res.json(await kernel.ritualAgenda(req.body.vaultId, req.body.ritual, { date: req.body.date })); } catch (e) { next(e); } });
  app.post("/v1/backlinks", ...read, async (req, res, next) => { try { res.json(await kernel.backlinks(req.body.vaultId, req.body.path, req.body.includeRestricted ?? false, req.body.limit)); } catch (e) { next(e); } });
  app.post("/v1/validate", ...read, async (req, res, next) => { try { res.json(await kernel.validate(req.body?.vaultId)); } catch (e) { next(e); } });
  app.post("/v1/writes/preview", ...write, async (req, res, next) => { try { res.json(await kernel.previewWrite(req.body)); } catch (e) { next(e); } });
  app.post("/v1/writes/apply", ...write, async (req, res, next) => { try { res.json(await kernel.applyWrite(req.body, { client: { id: req.auth!.clientId } })); } catch (e) { next(e); } });

  // A session belongs to the client that initialized it.
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; clientId: string }>();
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
          onsessioninitialized: (id) => { sessions.set(id, { transport: transport!, clientId }); }
        });
        transport.onclose = () => { if (transport?.sessionId) sessions.delete(transport.sessionId); };
        await createLifeKernelMcp(kernel).connect(transport);
      }
      if (!transport) return void res.status(400).json({ error: "Missing or invalid MCP session." });
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(400).json({ error: error instanceof Error ? error.message : String(error) }));
  return app;
}
