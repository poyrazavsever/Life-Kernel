import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LifeKernel, WriteRequestSchema } from "@lifekernel/core";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function createLifeKernelMcp(kernel: LifeKernel) {
  const server = new McpServer({ name: "lifekernel", version: "0.1.0-dev" });

  server.tool("vault_list", "List configured vaults and their permitted routes.", {}, async () => json(kernel.listVaults()));
  server.tool("vault_search", "Search Markdown notes and return source paths, line ranges, and hashes.", { query: z.string().min(1), vaultId: z.string().optional(), limit: z.number().int().min(1).max(100).default(20), includeRestricted: z.boolean().default(false) }, async (input) => json(await kernel.search(input.query, input.vaultId, input.limit, input.includeRestricted)));
  server.tool("note_read", "Read one Markdown note from a configured vault.", { vaultId: z.string(), path: z.string(), includeRestricted: z.boolean().default(false) }, async (input) => json(await kernel.readNote(input.vaultId, input.path, input.includeRestricted)));
  server.tool("write_preview", "Preview a routed create or append without changing the vault.", { request: WriteRequestSchema }, async (input) => json(await kernel.previewWrite(input.request)));
  server.tool("write_apply", "Apply a previously reviewed write request idempotently and record an audit event.", { request: WriteRequestSchema }, async (input) => json(await kernel.applyWrite(input.request)));
  server.tool("vault_validate", "Validate required frontmatter in one vault or all vaults.", { vaultId: z.string().optional() }, async (input) => json(await kernel.validate(input.vaultId)));
  server.tool("audit_recent", "Read recent local mutation audit events.", { limit: z.number().int().min(1).max(100).default(20) }, async (input) => json(await kernel.recentAudit(input.limit)));
  return server;
}
