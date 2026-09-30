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
    expect(names).toEqual(["audit_recent", "context_bundle", "daily_get", "note_backlinks", "note_read", "vault_list", "vault_search", "vault_validate", "write_apply", "write_preview"]);

    const search = await client.callTool({ name: "vault_search", arguments: { query: "needle" } });
    const text = (search.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("note.md");
    expect(text).not.toContain("hidden.md");
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
      expect(await ok.json()).toEqual([{ id: "test", kind: "personal", mode: "read-write", routes: [{ name: "daily", folder: "daily", type: "daily", policy: "auto" }] }]);
    } finally { await close(); }
  });

  it("refuses short tokens", async () => {
    expect(() => createHttpApp(undefined as never, { token: "short" })).toThrow(/24 characters/);
  });
});
