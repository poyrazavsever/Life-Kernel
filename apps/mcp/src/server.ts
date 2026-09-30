import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LifeKernel, WriteRequestSchema } from "@lifekernel/core";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function createLifeKernelMcp(kernel: LifeKernel) {
  const server = new McpServer({ name: "lifekernel", version: "0.1.0-dev" });

  server.tool("vault_list", "List configured vaults and their permitted routes.", {}, async () => json(kernel.listVaults()));
  server.tool("vault_search", "Search Markdown notes and return source paths, line ranges, and hashes.", { query: z.string().min(1), vaultId: z.string().optional(), limit: z.number().int().min(1).max(100).default(20), includeRestricted: z.boolean().default(false) }, async (input) => json(await kernel.search(input.query, input.vaultId, input.limit, input.includeRestricted)));
  server.tool("note_read", "Read one Markdown note from a configured vault.", { vaultId: z.string(), path: z.string(), includeRestricted: z.boolean().default(false) }, async (input) => json(await kernel.readNote(input.vaultId, input.path, input.includeRestricted)));
  server.tool("daily_get", "Return the single daily note for a date (default today in the configured time zone), or report that it does not exist yet.", { vaultId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), route: z.string().optional() }, async (input) => json(await kernel.dailyNote(input.vaultId, input.date, input.route)));
  server.tool("context_bundle", "Return the minimum session context: the vault's bundle notes, today's daily note, and recent daily notes, within a character budget. Each note includes the hash of the full note.", { vaultId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), maxChars: z.number().int().min(1000).max(200000).default(24000), recentDaily: z.number().int().min(0).max(14).default(3), includeRestricted: z.boolean().default(false) }, async (input) => json(await kernel.contextBundle(input.vaultId, input)));
  server.tool("note_backlinks", "List notes that link to a given note, with line excerpts.", { vaultId: z.string(), path: z.string(), limit: z.number().int().min(1).max(100).default(50), includeRestricted: z.boolean().default(false) }, async (input) => json(await kernel.backlinks(input.vaultId, input.path, input.includeRestricted, input.limit)));
  server.tool("write_preview", "Preview a routed create or append without changing the vault.", { request: WriteRequestSchema }, async (input) => json(await kernel.previewWrite(input.request)));
  server.tool("write_apply", "Apply a previously reviewed write request idempotently and record an audit event.", { request: WriteRequestSchema }, async (input) => json(await kernel.applyWrite(input.request)));
  server.tool("vault_validate", "Validate required frontmatter in one vault or all vaults.", { vaultId: z.string().optional() }, async (input) => json(await kernel.validate(input.vaultId)));
  server.tool("audit_recent", "Read recent local mutation audit events.", { limit: z.number().int().min(1).max(100).default(20) }, async (input) => json(await kernel.recentAudit(input.limit)));
  return server;
}
