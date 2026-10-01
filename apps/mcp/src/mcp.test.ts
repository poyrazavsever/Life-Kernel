import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LifeKernel, type LifeKernelConfig } from "@lifekernel/core";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { createLifeKernelMcp } from "./server.js";

const token = "test-token-with-at-least-24-characters";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-mcp-"));
  const vault = join(root, "vault");
  await mkdir(vault);
  await writeFile(join(vault, "note.md"), "---\nid: n\ntype: note\nstatus: active\narea: test\nprivacy: personal\nai_access: context\n---\n\n# Needle note\n", "utf8");
  await writeFile(join(vault, "hidden.md"), "---\nid: h\ntype: note\nstatus: active\narea: test\nprivacy: private\nai_access: none\n---\n\n# Needle hidden\n", "utf8");
  const config: LifeKernelConfig = {
    version: 1,
    stateDir: join(root, "state"),
    timezone: "UTC",
    vaults: [{ id: "test", kind: "personal", path: vault, mode: "read-write", routes: { daily: { folder: "daily", type: "daily", status: "active", area: "life", policy: "auto" } } }]
  };
  return new LifeKernel(config);
}

describe("MCP tools", () => {
  it("exposes the constrained tool set and honors AI access", async () => {
    const kernel = await fixture();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createLifeKernelMcp(kernel).connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["audit_recent", "context_bundle", "daily_get", "note_backlinks", "note_list", "note_read", "period_get", "ritual_agenda", "ritual_status", "skill_get", "tasks_open", "vault_list", "vault_search", "vault_validate", "write_apply", "write_preview"]);

    const search = await client.callTool({ name: "vault_search", arguments: { query: "needle" } });
    const text = (search.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("note.md");
    expect(text).not.toContain("hidden.md");
  });

  it("names the writing client in the audit log", async () => {
    const kernel = await fixture();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createLifeKernelMcp(kernel).connect(serverSide);
    const client = new Client({ name: "audit-client", version: "0.0.0" });
    await client.connect(clientSide);

    const request = { requestId: "audit-0001", vaultId: "test", operation: "create", route: "daily", title: "Day", body: "Done.", source: "test", sourceDate: "2026-09-30" };
    await client.callTool({ name: "write_apply", arguments: { request } });
    const [event] = await kernel.recentAudit(1);
    expect(event).toMatchObject({ event: "write_applied", client: { name: "audit-client" } });
    expect(event.client).not.toHaveProperty("id");
  });
});

describe("HTTP surface", () => {
  async function serve() {
    const app = createHttpApp(await fixture(), { token });
    const server = await new Promise<import("node:http").Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("requires the bearer token and rejects unknown origins", async () => {
    const { base, close } = await serve();
    try {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/v1/vaults`)).status).toBe(401);
      expect((await fetch(`${base}/v1/vaults`, { headers: { authorization: "Bearer wrong-token-wrong-token-wrong" } })).status).toBe(401);
      expect((await fetch(`${base}/v1/vaults`, { headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } })).status).toBe(403);
      const ok = await fetch(`${base}/v1/vaults`, { headers: { authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual([{ id: "test", kind: "personal", mode: "read-write", routes: [{ name: "daily", folder: "daily", type: "daily", policy: "auto", period: "day", fields: [] }] }]);
    } finally { await close(); }
  });

  it("refuses short tokens", async () => {
    expect(() => createHttpApp(undefined as never, { token: "short" })).toThrow(/24 characters/);
  });
});

describe("skills over MCP", () => {
  async function connect() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createLifeKernelMcp(await fixture()).connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("ships instructions that point the agent at skill_get", async () => {
    const client = await connect();
    expect(client.getInstructions()).toMatch(/skill_get/);
  });

  it("serves the canonical skill text by tool and by prompt", async () => {
    const client = await connect();
    const tool = await client.callTool({ name: "skill_get", arguments: { name: "daily-circle" } });
    const text = (tool.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/# Daily circle/);
    expect(text).not.toMatch(/^---/);

    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["daily_circle", "monthly_review", "morning_plan", "onboarding", "project_memory", "quarterly_review", "second_brain", "weekly_review"]);
    const prompt = await client.getPrompt({ name: "daily_circle", arguments: { vaultId: "test" } });
    const body = (prompt.messages[0]!.content as { text: string }).text;
    expect(body).toContain(text);
    expect(body).toContain("Use vault: test");
  });

  it("reports unknown skills as tool errors", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "skill_get", arguments: { name: "nope" } });
    expect(result.isError).toBe(true);
  });

  it("only references tools and routes that exist", async () => {
    const client = await connect();
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(await readFile(new URL("../../../lifekernel.config.example.json", import.meta.url), "utf8")) as { vaults: Array<{ routes: Record<string, { fields?: string[] }> }> };
    const routes = new Set(Object.keys(config.vaults[0]!.routes));
    // Frontmatter keys such as daily_circle_time share a prefix with tools; they are checked against route fields instead.
    const fields = new Set(Object.values(config.vaults[0]!.routes).flatMap((route) => route.fields ?? []));
    for (const name of ["onboarding", "morning-plan", "daily-circle", "weekly-review", "monthly-review", "quarterly-review", "second-brain", "project-memory"]) {
      const text = ((await client.callTool({ name: "skill_get", arguments: { name } })).content as Array<{ text: string }>)[0]!.text;
      for (const [, tool] of text.matchAll(/`((?:vault|note|write|daily|period|tasks|ritual|context|audit|skill)_[a-z_]+)`/g)) expect(tools.has(tool!) || fields.has(tool!), `${name} mentions unknown tool ${tool}`).toBe(true);
      for (const [, route] of text.matchAll(/routes? `([a-z]+)`/g)) expect(routes.has(route!), `${name} mentions unknown route ${route}`).toBe(true);
    }
  });
});
