import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifeKernel, localDate, resolveMarkdownPath, type LifeKernelConfig } from "./index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-"));
  const vault = join(root, "vault");
  await mkdir(vault);
  const config: LifeKernelConfig = {
    version: 1,
    stateDir: join(root, "state"),
    timezone: "UTC",
    vaults: [{ id: "test", kind: "project", path: vault, mode: "read-write", routes: { session: { folder: "sessions", type: "session", status: "active", area: "project", policy: "auto" }, reviewed: { folder: "reviewed", type: "decision", status: "proposed", area: "project", policy: "review" }, blocked: { folder: "blocked", type: "note", status: "active", area: "project", policy: "deny" } } }]
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

describe("request identity", () => {
  it("rejects request IDs that could escape the receipt directory", async () => {
    const { kernel } = await fixture();
    for (const requestId of ["../../escape-me", "a/b/c/d/e/f/g/h", "short", "bad id with spaces"]) {
      await expect(kernel.applyWrite({ requestId, vaultId: "test", operation: "create", route: "session", title: "T", body: "B", source: "test", sourceDate: "2026-09-30" })).rejects.toThrow(/requestId/);
    }
  });
});

describe("time zone", () => {
  it("formats the local calendar date instead of the UTC date", () => {
    const at = new Date("2026-09-30T22:30:00Z");
    expect(localDate("UTC", at)).toBe("2026-09-30");
    expect(localDate("Europe/Istanbul", at)).toBe("2026-10-01");
  });
});

describe("route policy levels", () => {
  const base = { vaultId: "test", operation: "create", title: "Choose a stack", body: "Decided on TypeScript.", source: "test", sourceDate: "2026-09-30" };

  it("requires explicit approval to apply a review route", async () => {
    const { kernel, vault } = await fixture();
    const request = { ...base, requestId: "request-0101", route: "reviewed" };
    await expect(kernel.previewWrite(request)).resolves.toMatchObject({ policy: "review" });
    await expect(kernel.applyWrite(request)).rejects.toThrow(/requires user approval/);
    await expect(readFile(join(vault, "reviewed/2026-09-30-choose-a-stack.md"), "utf8")).rejects.toThrow();
    await expect(kernel.applyWrite({ ...request, approved: true })).resolves.toMatchObject({ replayed: false });
  });

  it("refuses denied routes for preview and apply", async () => {
    const { kernel } = await fixture();
    const request = { ...base, requestId: "request-0102", route: "blocked" };
    await expect(kernel.previewWrite(request)).rejects.toThrow(/denied/);
    await expect(kernel.applyWrite({ ...request, approved: true })).rejects.toThrow(/denied/);
  });

  it("applies auto routes without approval and defaults unspecified policy to review", async () => {
    const { kernel } = await fixture();
    await expect(kernel.applyWrite({ ...base, requestId: "request-0103", route: "session" })).resolves.toMatchObject({ policy: "auto" });
    const { loadConfig } = await import("./index.js");
    const { root } = await fixture();
    await writeFile(join(root, "c.json"), JSON.stringify({ version: 1, vaults: [{ id: "v", kind: "personal", path: "./v", mode: "read-write", routes: { r: { folder: "r", type: "note", status: "active", area: "x" } } }] }));
    expect((await loadConfig(join(root, "c.json"))).vaults[0]!.routes.r!.policy).toBe("review");
  });
});
