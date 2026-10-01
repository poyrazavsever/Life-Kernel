import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
  return { root, vault, config, kernel: new LifeKernel(config, { now: () => NOW }) };
}

const NOW = new Date("2026-09-30T12:00:00Z");
const frontmatter = (access = "context") => `---\nid: x\ntype: note\nstatus: active\narea: test\nprivacy: personal\nai_access: ${access}\n---\n`;

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

describe("update_section", () => {
  const note = [
    "---", 'id: "s"', 'type: "state"', 'status: "active"', 'area: "project"', 'privacy: "personal"', 'ai_access: "context"', 'updated: "2026-01-01"', "---", "",
    "# Current state", "", "## Right now", "", "Old focus.", "", "```md", "## Waiting on", "```", "", "### Detail", "", "Nested stays with its parent.", "",
    "## Waiting on", "", "Nothing.", ""
  ].join("\n");

  async function withNote() {
    const f = await fixture();
    await mkdir(join(f.vault, "sessions"));
    await writeFile(join(f.vault, "sessions/state.md"), note, "utf8");
    const read = await f.kernel.readNote("test", "sessions/state.md");
    const request = { requestId: "request-0201", vaultId: "test", operation: "update_section", route: "session", title: "State", targetPath: "sessions/state.md", section: "Right now", expectedSha256: read.sha256, body: "New focus.", source: "test", sourceDate: "2026-09-30" };
    return { ...f, request };
  }

  it("replaces one section including nested headings, ignores fenced headings, and bumps updated", async () => {
    const { kernel, vault, request } = await withNote();
    const preview = await kernel.previewWrite(request);
    expect(preview.preview).toContain("New focus.");
    await kernel.applyWrite(request);
    const after = await readFile(join(vault, "sessions/state.md"), "utf8");
    expect(after).toContain("## Right now\n\nNew focus.\n\n## Waiting on\n\nNothing.");
    expect(after).not.toContain("Old focus.");
    expect(after).not.toContain("Nested stays");
    expect(after).toContain('updated: "2026-09-30"');
    expect(after.startsWith("---\nid:")).toBe(true);
  });

  it("rejects unknown sections, ambiguous headings, missing section, and stale hashes", async () => {
    const { kernel, request } = await withNote();
    await expect(kernel.previewWrite({ ...request, section: "Missing" })).rejects.toThrow(/not found/);
    await expect(kernel.previewWrite({ ...request, section: undefined })).rejects.toThrow(/section is required/);
    await expect(kernel.previewWrite({ ...request, expectedSha256: "0".repeat(64) })).rejects.toThrow(/changed/);
    await expect(kernel.previewWrite({ ...request, operation: "append" })).rejects.toThrow(/only accepted/);
    const { vault, kernel: k2 } = await fixture();
    await mkdir(join(vault, "sessions"));
    await writeFile(join(vault, "sessions/dup.md"), "# A\n\n## Same\n\nx\n\n## Same\n\ny\n", "utf8");
    const read = await k2.readNote("test", "sessions/dup.md");
    await expect(k2.previewWrite({ ...request, requestId: "request-0202", targetPath: "sessions/dup.md", section: "Same", expectedSha256: read.sha256 })).rejects.toThrow(/ambiguous/);
  });

  it("stays inside the route folder", async () => {
    const { kernel, vault, request } = await withNote();
    await writeFile(join(vault, "outside.md"), note, "utf8");
    const read = await kernel.readNote("test", "outside.md");
    await expect(kernel.previewWrite({ ...request, targetPath: "outside.md", expectedSha256: read.sha256 })).rejects.toThrow(/outside the selected route/);
  });
});

describe("daily notes", () => {
  async function dailyFixture() {
    const f = await fixture();
    f.kernel.config.vaults[0]!.routes.daily = { folder: "daily", type: "daily", status: "active", area: "life", policy: "auto" };
    return f;
  }
  const base = { vaultId: "test", operation: "create", route: "daily", body: "Shipped phase two.", source: "test", sourceDate: "2026-09-30" };

  it("reports a missing note, then finds it after creating", async () => {
    const { kernel } = await dailyFixture();
    await expect(kernel.dailyNote("test", "2026-09-30")).resolves.toMatchObject({ exists: false, path: "daily/2026-09-30.md" });
    await kernel.applyWrite({ ...base, requestId: "request-0301", title: "Daily circle" });
    const found = await kernel.dailyNote("test", "2026-09-30");
    expect(found).toMatchObject({ exists: true, path: "daily/2026-09-30.md" });
    expect(found.exists && found.content).toContain("Shipped phase two.");
  });

  it("prevents a second daily note for the same date even with another title", async () => {
    const { kernel } = await dailyFixture();
    await kernel.applyWrite({ ...base, requestId: "request-0302", title: "Daily circle" });
    await expect(kernel.applyWrite({ ...base, requestId: "request-0303", title: "Evening review" })).rejects.toThrow(/already exists/);
  });

  it("requires a daily route and a valid date", async () => {
    const { kernel } = await fixture();
    await expect(kernel.dailyNote("test", "2026-09-30")).rejects.toThrow(/no daily route/);
    const { kernel: k2 } = await dailyFixture();
    await expect(k2.dailyNote("test", "30-09-2026")).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("context bundle", () => {
  const note = (access: string, body: string) => `---\nid: x\ntype: note\nstatus: active\narea: test\nprivacy: personal\nai_access: ${access}\n---\n\n${body}\n`;

  async function bundleFixture() {
    const f = await fixture();
    const vaultConfig = f.kernel.config.vaults[0]!;
    vaultConfig.routes.daily = { folder: "daily", type: "daily", status: "active", area: "life", policy: "auto" };
    vaultConfig.bundle = ["system/Method.md", "system/Secret.md", "system/Private.md", "system/Absent.md"];
    await mkdir(join(f.vault, "system"));
    await mkdir(join(f.vault, "daily"));
    await writeFile(join(f.vault, "system/Method.md"), note("context", "Method body"), "utf8");
    await writeFile(join(f.vault, "system/Secret.md"), note("none", "never"), "utf8");
    await writeFile(join(f.vault, "system/Private.md"), note("restricted", "sensitive"), "utf8");
    for (const day of ["2026-09-26", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-02"]) await writeFile(join(f.vault, `daily/${day}.md`), note("context", `Day ${day}`), "utf8");
    return f;
  }

  it("includes bundle notes, today, and recent earlier days while reporting skips", async () => {
    const { kernel } = await bundleFixture();
    const bundle = await kernel.contextBundle("test", { date: "2026-09-30", recentDaily: 2 });
    expect(bundle.notes.map((n) => n.path)).toEqual(["system/Method.md", "daily/2026-09-30.md", "daily/2026-09-29.md", "daily/2026-09-28.md"]);
    expect(bundle.skipped).toEqual([
      { path: "system/Secret.md", reason: "excluded" },
      { path: "system/Private.md", reason: "restricted" },
      { path: "system/Absent.md", reason: "missing" }
    ]);
    expect(JSON.stringify(bundle)).not.toMatch(/never|sensitive|2026-10-02/);
  });

  it("includes restricted notes only on request and truncates to the budget while keeping the full hash", async () => {
    const { kernel } = await bundleFixture();
    expect((await kernel.contextBundle("test", { date: "2026-09-30", includeRestricted: true })).notes.some((n) => n.path === "system/Private.md")).toBe(true);
    const tiny = await kernel.contextBundle("test", { date: "2026-09-30", maxChars: 1000 });
    expect(tiny.totalChars).toBeLessThanOrEqual(1000);
    const full = await kernel.readNote("test", "system/Method.md");
    expect(tiny.notes[0]).toMatchObject({ path: "system/Method.md", sha256: full.sha256, truncated: false });
  });

  it("lists today as missing when no daily note exists yet", async () => {
    const { kernel } = await bundleFixture();
    const bundle = await kernel.contextBundle("test", { date: "2026-09-27", recentDaily: 1 });
    expect(bundle.skipped).toContainEqual({ path: "daily/2026-09-27.md", reason: "missing" });
    expect(bundle.notes.map((n) => n.path)).toContain("daily/2026-09-26.md");
  });
});

describe("backlinks", () => {
  it("finds links by path or name, honors AI access, and excludes the target", async () => {
    const { kernel, vault } = await fixture();
    const note = (access: string, body: string) => `---\nid: x\ntype: note\nstatus: active\narea: test\nprivacy: personal\nai_access: ${access}\n---\n\n${body}\n`;
    await mkdir(join(vault, "projects"));
    await writeFile(join(vault, "projects/Alpha.md"), note("context", "Self link [[Alpha]]"), "utf8");
    await writeFile(join(vault, "a.md"), note("context", "See [[projects/Alpha]] and later [[projects/Alpha|the project]]."), "utf8");
    await writeFile(join(vault, "b.md"), note("context", "Mentions [[alpha#Tasks]] here."), "utf8");
    await writeFile(join(vault, "hidden.md"), note("none", "Hidden [[Alpha]]"), "utf8");
    await writeFile(join(vault, "unrelated.md"), note("context", "About [[Alphabet]]."), "utf8");
    const hits = await kernel.backlinks("test", "projects/Alpha.md");
    expect(hits.map((h) => h.path).sort()).toEqual(["a.md", "b.md"]);
    await expect(kernel.backlinks("test", "../escape.md")).rejects.toThrow(/escapes/);
  });
});

describe("audit log", () => {
  it("records the change without copying note text", async () => {
    const { kernel } = await fixture();
    await kernel.applyWrite({ requestId: "request-0401", vaultId: "test", operation: "create", route: "session", title: "Private", body: "Highly personal sentence.", source: "test", sourceDate: "2026-09-30" });
    const [event] = await kernel.recentAudit(1);
    expect(event).toMatchObject({ event: "write_applied", path: "sessions/2026-09-30-private.md", operation: "create" });
    expect(JSON.stringify(event)).not.toContain("Highly personal sentence");
    expect(event).not.toHaveProperty("preview");
  });
});

describe("line endings", () => {
  const crlf = (text: string) => text.replaceAll("\n", "\r\n");

  it("validates and enforces AI access on CRLF notes and notes with a BOM", async () => {
    const { kernel, vault } = await fixture();
    await writeFile(join(vault, "windows.md"), crlf(`${frontmatter()}\n# Windows\n`), "utf8");
    await writeFile(join(vault, "bom.md"), `﻿${frontmatter()}\n# Bom\n`, "utf8");
    await writeFile(join(vault, "hidden.md"), crlf(`${frontmatter("none")}\n# Hidden needle\n`), "utf8");
    expect(await kernel.validate("test")).toEqual({ ok: true, notes: 3, issues: [] });
    await expect(kernel.readNote("test", "hidden.md", true)).rejects.toThrow(/excluded/);
    await expect(kernel.search("needle", "test", 20, true)).resolves.toEqual([]);
  });

  it("keeps CRLF line endings when appending", async () => {
    const { kernel, vault } = await fixture();
    await mkdir(join(vault, "sessions"));
    await writeFile(join(vault, "sessions/log.md"), crlf(`${frontmatter()}\n# Log\n`), "utf8");
    const read = await kernel.readNote("test", "sessions/log.md");
    await kernel.applyWrite({ requestId: "request-0501", vaultId: "test", operation: "append", route: "session", title: "Log", targetPath: "sessions/log.md", expectedSha256: read.sha256, body: "First line.\nSecond line.", source: "test", sourceDate: "2026-09-30" });
    const after = await readFile(join(vault, "sessions/log.md"), "utf8");
    expect(after).toContain("# Log\r\n\r\nFirst line.\r\nSecond line.\r\n");
    expect(after.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

describe("slugs", () => {
  it("transliterates Turkish and other letters that NFKD leaves alone", async () => {
    const { kernel } = await fixture();
    const preview = await kernel.previewWrite({ requestId: "request-0601", vaultId: "test", operation: "create", route: "session", title: "Kısa vadeli hedef: İstanbul'da Çalışma Şekli", body: "x", source: "test", sourceDate: "2026-09-30" });
    expect(preview.path).toBe("sessions/2026-09-30-kisa-vadeli-hedef-istanbul-da-calisma-sekli.md");
  });

  it("falls back to a slug derived from the request ID, so preview and apply agree", async () => {
    const { kernel } = await fixture();
    const request = { requestId: "request-0602", vaultId: "test", operation: "create", route: "session", title: "日本語", body: "x", source: "test", sourceDate: "2026-09-30" };
    const preview = await kernel.previewWrite(request);
    expect(preview.path).toBe("sessions/2026-09-30-note-request-0602.md");
    expect((await kernel.applyWrite(request)).path).toBe(preview.path);
  });
});

describe("concurrent writers", () => {
  it("lets exactly one of two processes win a race on the same note", async () => {
    const { config, vault } = await fixture();
    await mkdir(join(vault, "sessions"));
    await writeFile(join(vault, "sessions/state.md"), `${frontmatter()}\n# State\n\n## Now\n\nOld.\n`, "utf8");
    const [first, second] = [new LifeKernel(config, { now: () => NOW }), new LifeKernel(config, { now: () => NOW })];
    const { sha256 } = await first.readNote("test", "sessions/state.md");
    const request = (requestId: string, body: string) => ({ requestId, vaultId: "test", operation: "update_section", route: "session", title: "State", targetPath: "sessions/state.md", section: "Now", expectedSha256: sha256, body, source: "test", sourceDate: "2026-09-30" });
    const results = await Promise.allSettled([first.applyWrite(request("race-0001", "From A.")), second.applyWrite(request("race-0002", "From B."))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(String(failure.reason)).toMatch(/changed after it was read/);
    const after = await readFile(join(vault, "sessions/state.md"), "utf8");
    expect(after.includes("From A.")).not.toBe(after.includes("From B."));
  });

  it("takes over a stale lock left by a crashed process", async () => {
    const { kernel, config } = await fixture();
    await mkdir(join(config.stateDir, "locks"), { recursive: true });
    const lock = join(config.stateDir, "locks/test.lock");
    await writeFile(lock, "{}", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await expect(kernel.applyWrite({ requestId: "request-0701", vaultId: "test", operation: "create", route: "session", title: "After crash", body: "x", source: "test", sourceDate: "2026-09-30" })).resolves.toMatchObject({ replayed: false });
  });
});

describe("crash recovery", () => {
  const request = { requestId: "request-0801", vaultId: "test", operation: "create", route: "session", title: "Recovered", body: "Recovered body.", source: "test", sourceDate: "2026-09-30" };

  async function crashedAfterNoteWrite() {
    const f = await fixture();
    const applied = await f.kernel.applyWrite(request);
    // Simulate a crash between the note write and the final receipt: the receipt is still pending.
    const receiptPath = join(f.config.stateDir, "requests/request-0801.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const { appliedAt: _appliedAt, ...preview } = receipt.result;
    await writeFile(receiptPath, JSON.stringify({ fingerprint: receipt.fingerprint, state: "pending", result: preview }), "utf8");
    return { ...f, applied };
  }

  it("finishes a write whose note landed before the crash instead of failing on retry", async () => {
    const { kernel, applied } = await crashedAfterNoteWrite();
    await expect(kernel.applyWrite(request)).resolves.toMatchObject({ replayed: false, path: applied.path, afterSha256: applied.afterSha256 });
    expect((await kernel.applyWrite(request)).replayed).toBe(true);
  });

  it("redoes a write whose note never landed", async () => {
    const { kernel, vault, applied } = await crashedAfterNoteWrite();
    await rm(join(vault, applied.path));
    await expect(kernel.applyWrite(request)).resolves.toMatchObject({ replayed: false, afterSha256: applied.afterSha256 });
    expect(await readFile(join(vault, applied.path), "utf8")).toContain("Recovered body.");
  });

  it("still replays receipts written before receipts had a state", async () => {
    const { kernel, config } = await fixture();
    const applied = await kernel.applyWrite({ ...request, requestId: "request-0802" });
    const receiptPath = join(config.stateDir, "requests/request-0802.json");
    const { state: _state, ...legacy } = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeFile(receiptPath, JSON.stringify(legacy), "utf8");
    await expect(kernel.applyWrite({ ...request, requestId: "request-0802" })).resolves.toMatchObject({ replayed: true, appliedAt: applied.appliedAt });
  });
});

describe("writer identity", () => {
  it("records the client in the audit event when one is given", async () => {
    const { kernel } = await fixture();
    await kernel.applyWrite({ requestId: "request-0901", vaultId: "test", operation: "create", route: "session", title: "Who", body: "x", source: "test", sourceDate: "2026-09-30" }, { client: { id: "abc", name: "claude-code" } });
    await kernel.applyWrite({ requestId: "request-0902", vaultId: "test", operation: "create", route: "session", title: "Anonymous", body: "x", source: "test", sourceDate: "2026-09-30" });
    const [named, anonymous] = await kernel.recentAudit(2);
    expect(named).toMatchObject({ client: { id: "abc", name: "claude-code" }, appliedAt: NOW.toISOString() });
    expect(anonymous).not.toHaveProperty("client");
  });
});
