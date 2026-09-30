import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LifeKernel, loadConfig } from "@lifekernel/core";
import { describe, expect, it } from "vitest";
import { createLifeKernelMcp } from "./server.js";

const repo = new URL("../../../", import.meta.url);

async function session() {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-e2e-"));
  await cp(new URL("templates/starter-vault", repo), join(root, "vault"), { recursive: true });
  const example = JSON.parse(await readFile(new URL("lifekernel.config.example.json", repo), "utf8"));
  example.vaults[0].path = "./vault";
  example.timezone = "UTC";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "lifekernel.config.json"), JSON.stringify(example));
  const kernel = new LifeKernel(await loadConfig(join(root, "lifekernel.config.json")));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createLifeKernelMcp(kernel).connect(serverSide);
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { root, call };
}

describe("daily circle against the starter vault", () => {
  it("creates the daily note, updates plan and state sections, and stays idempotent", async () => {
    const { root, call } = await session();
    const date = "2026-09-30";

    const bundle = await call("context_bundle", { vaultId: "personal", date });
    expect(bundle.notes.map((n: { path: string }) => n.path)).toContain("system/Method.md");

    const daily = await call("daily_get", { vaultId: "personal", date });
    expect(daily.exists).toBe(false);

    const create = { requestId: "e2e-daily-0001", vaultId: "personal", operation: "create", route: "daily", title: `${date} Daily Circle`, body: "## Day summary\n\nShipped the tool surface.\n\n## Tomorrow's focus\n\nOAuth.", source: "daily circle", sourceDate: date };
    await call("write_preview", { request: create });
    expect((await call("write_apply", { request: create })).replayed).toBe(false);
    expect((await call("write_apply", { request: create })).replayed).toBe(true);
    await expect(call("write_apply", { request: { ...create, requestId: "e2e-daily-0002" } })).rejects.toThrow(/already exists/);

    for (const [route, path, section, body] of [
      ["plan", "schedule/Near-Term Plan.md", "Focus for tomorrow", "Start OAuth."],
      ["state", "state/Current State.md", "Right now", "Phase 3 done."]
    ]) {
      const note = await call("note_read", { vaultId: "personal", path });
      const request = { requestId: `e2e-${route}-0001`, vaultId: "personal", operation: "update_section", route, title: String(section), targetPath: path, section, expectedSha256: note.sha256, body, source: "daily circle", sourceDate: date };
      expect((await call("write_apply", { request })).policy).toBe("auto");
      expect(await readFile(join(root, "vault", String(path)), "utf8")).toContain(`## ${section}\n\n${body}`);
    }
  });

  it("requires approval for review routes such as the planning method", async () => {
    const { call } = await session();
    const note = await call("note_read", { vaultId: "personal", path: "system/Method.md" });
    const request = { requestId: "e2e-method-0001", vaultId: "personal", operation: "update_section", route: "method", title: "Method", targetPath: "system/Method.md", section: "Chosen approach", expectedSha256: note.sha256, body: "Themed days.", source: "onboarding", sourceDate: "2026-09-30" };
    await expect(call("write_apply", { request })).rejects.toThrow(/requires user approval/);
    expect((await call("write_apply", { request: { ...request, approved: true } })).replayed).toBe(false);
  });
});
