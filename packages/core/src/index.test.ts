import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifeKernel, resolveMarkdownPath, type LifeKernelConfig } from "./index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-"));
  const vault = join(root, "vault");
  await mkdir(vault);
  const config: LifeKernelConfig = {
    version: 1,
    stateDir: join(root, "state"),
    vaults: [{ id: "test", kind: "project", path: vault, mode: "read-write", routes: { session: { folder: "sessions", type: "session", status: "active", area: "project" } } }]
  };
  return { root, vault, kernel: new LifeKernel(config) };
}

describe("path policy", () => {
  it("rejects paths outside a vault", async () => {
    const { vault } = await fixture();
    expect(() => resolveMarkdownPath(vault, "../secret.md")).toThrow(/escapes/);
  });
});

describe("writes", () => {
  it("creates once and replays the same request", async () => {
    const { kernel, vault } = await fixture();
    const request = { requestId: "request-0001", vaultId: "test", operation: "create", route: "session", title: "Completed API", body: "Added authenticated MCP access.", source: "test", sourceDate: "2026-09-29" };
    const preview = await kernel.previewWrite(request);
    const first = await kernel.applyWrite(request);
    const second = await kernel.applyWrite(request);
    expect(first.replayed).toBe(false);
    expect(first.afterSha256).toBe(preview.afterSha256);
    expect(second.replayed).toBe(true);
    expect(await readFile(join(vault, "sessions/2026-09-29-completed-api.md"), "utf8")).toContain("Added authenticated MCP access");
  });

  it("rejects stale appends", async () => {
    const { kernel, vault } = await fixture();
    await mkdir(join(vault, "sessions"));
    await writeFile(join(vault, "sessions/existing.md"), "---\nid: x\ntype: session\nstatus: active\narea: project\nprivacy: personal\nai_access: context\n---\n\n# Existing\n", "utf8");
    await expect(kernel.previewWrite({ requestId: "request-0002", vaultId: "test", operation: "append", route: "session", title: "Ignored", targetPath: "sessions/existing.md", expectedSha256: "0".repeat(64), body: "New", source: "test", sourceDate: "2026-09-29" })).rejects.toThrow(/changed/);
  });
});

describe("validation", () => {
  it("treats AGENTS.md as vault infrastructure, not a managed note", async () => {
    const { kernel, vault } = await fixture();
    await writeFile(join(vault, "AGENTS.md"), "# Agent instructions\n", "utf8");
    await writeFile(join(vault, "valid.md"), "---\nid: valid\ntype: note\nstatus: active\narea: test\nprivacy: personal\nai_access: context\n---\n\n# Valid\n", "utf8");
    const result = await kernel.validate("test");
    expect(result).toEqual({ ok: true, notes: 1, issues: [] });
  });
});

describe("AI access policy", () => {
  it("never exposes none notes and requires an explicit flag for restricted notes", async () => {
    const { kernel, vault } = await fixture();
    await writeFile(join(vault, "none.md"), "---\nid: none\ntype: note\nstatus: active\narea: test\nprivacy: private\nai_access: none\n---\n\n# Hidden needle\n", "utf8");
    await writeFile(join(vault, "restricted.md"), "---\nid: restricted\ntype: note\nstatus: active\narea: test\nprivacy: private\nai_access: restricted\n---\n\n# Restricted needle\n", "utf8");

    await expect(kernel.readNote("test", "none.md", true)).rejects.toThrow(/excluded/);
    await expect(kernel.readNote("test", "restricted.md")).rejects.toThrow(/explicit restricted/);
    await expect(kernel.readNote("test", "restricted.md", true)).resolves.toMatchObject({ path: "restricted.md" });
    await expect(kernel.search("needle", "test", 20)).resolves.toEqual([]);
    await expect(kernel.search("needle", "test", 20, true)).resolves.toHaveLength(1);
  });
});

describe("route policy", () => {
  it("rejects appends outside the selected route folder", async () => {
    const { kernel, vault } = await fixture();
    await writeFile(join(vault, "outside.md"), "---\nid: outside\ntype: note\nstatus: active\narea: test\nprivacy: personal\nai_access: context\n---\n\n# Outside\n", "utf8");
    const target = await kernel.readNote("test", "outside.md");
    await expect(kernel.previewWrite({ requestId: "request-0003", vaultId: "test", operation: "append", route: "session", title: "Outside", targetPath: "outside.md", expectedSha256: target.sha256, body: "Should fail", source: "test", sourceDate: "2026-09-30" })).rejects.toThrow(/outside the selected route/);
  });
});
