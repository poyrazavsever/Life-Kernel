import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type LifeKernel } from "@lifekernel/core";
import { createLifeKernelMcp } from "./server.js";

export interface HttpAppOptions { token: string; origins?: Set<string>; host?: string }

export function createHttpApp(kernel: LifeKernel, options: HttpAppOptions) {
  const { token, origins = new Set<string>(), host = "127.0.0.1" } = options;
  if (token.length < 24) throw new Error("LIFEKERNEL_API_TOKEN must contain at least 24 characters.");
  const app = createMcpExpressApp({ host });
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, service: "lifekernel", version: "0.1.0-alpha.0" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (origin && !origins.has(origin)) return res.status(403).json({ error: "Origin is not allowed." });
    const provided = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const expected = Buffer.from(token);
    const actual = Buffer.from(provided);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.status(401).json({ error: "Unauthorized" });
    next();
  });

  app.get("/v1/vaults", (_req, res) => res.json(kernel.listVaults()));
  app.post("/v1/search", async (req, res, next) => { try { res.json(await kernel.search(req.body.query, req.body.vaultId, req.body.limit, req.body.includeRestricted ?? false)); } catch (e) { next(e); } });
  app.post("/v1/read", async (req, res, next) => { try { res.json(await kernel.readNote(req.body.vaultId, req.body.path, req.body.includeRestricted ?? false)); } catch (e) { next(e); } });
  app.post("/v1/daily", async (req, res, next) => { try { res.json(await kernel.dailyNote(req.body.vaultId, req.body.date, req.body.route)); } catch (e) { next(e); } });
  app.post("/v1/context", async (req, res, next) => { try { res.json(await kernel.contextBundle(req.body.vaultId, req.body)); } catch (e) { next(e); } });
  app.post("/v1/backlinks", async (req, res, next) => { try { res.json(await kernel.backlinks(req.body.vaultId, req.body.path, req.body.includeRestricted ?? false, req.body.limit)); } catch (e) { next(e); } });
  app.post("/v1/writes/preview", async (req, res, next) => { try { res.json(await kernel.previewWrite(req.body)); } catch (e) { next(e); } });
  app.post("/v1/writes/apply", async (req, res, next) => { try { res.json(await kernel.applyWrite(req.body)); } catch (e) { next(e); } });
  app.post("/v1/validate", async (req, res, next) => { try { res.json(await kernel.validate(req.body?.vaultId)); } catch (e) { next(e); } });

  const transports = new Map<string, StreamableHTTPServerTransport>();
  app.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.header("mcp-session-id");
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, transport!); }
        });
        transport.onclose = () => { if (transport?.sessionId) transports.delete(transport.sessionId); };
        await createLifeKernelMcp(kernel).connect(transport);
      }
      if (!transport) return res.status(400).json({ error: "Missing or invalid MCP session." });
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(400).json({ error: error instanceof Error ? error.message : String(error) }));
  return app;
}
