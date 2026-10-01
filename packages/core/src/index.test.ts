import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    await writeFile(join(vault, "bom.md"), `\uFEFF${frontmatter()}\n# Bom\n`, "utf8");
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

async function planningFixture() {
  const f = await fixture();
  Object.assign(f.config.vaults[0]!.routes, {
    decision: { folder: "decisions", type: "decision", status: "proposed", area: "system", policy: "review", fields: ["status", "decided_on", "supersedes"] },
    daily: { folder: "daily", type: "daily", status: "active", area: "life", policy: "auto", fields: ["energy", "focus_hours", "circle"] },
    review: { folder: "reviews", type: "weekly-review", status: "active", area: "life", policy: "auto", period: "week", fields: ["status"] },
    monthly: { folder: "reviews", type: "monthly-review", status: "active", area: "life", policy: "auto", period: "month" },
    project: { folder: "projects", type: "project", status: "active", area: "projects", policy: "auto", fields: ["status", "next_action", "due"] }
  });
  return f;
}
const write = (fields: Record<string, unknown>) => ({ vaultId: "test", source: "test", sourceDate: "2026-09-30", ...fields });

describe("set_frontmatter", () => {
  it("accepts a proposed decision only with approval, and keeps the body", async () => {
    const { kernel, vault } = await planningFixture();
    await kernel.applyWrite(write({ requestId: "decision-0001", operation: "create", route: "decision", title: "Use TypeScript", body: "Because of the MCP SDK.", approved: true }));
    const note = await kernel.readNote("test", "decisions/2026-09-30-use-typescript.md");
    const request = write({ requestId: "decision-0002", operation: "set_frontmatter", route: "decision", targetPath: note.path, expectedSha256: note.sha256, fields: { status: "accepted", decided_on: "2026-09-30" } });
    const preview = await kernel.previewWrite(request);
    expect(preview.preview).toMatch(/^---\n[\s\S]*status: "accepted"[\s\S]*---$/);
    expect(preview.preview).not.toContain("Because of the MCP SDK");
    await expect(kernel.applyWrite(request)).rejects.toThrow(/requires user approval/);
    await kernel.applyWrite({ ...request, approved: true });
    const after = await readFile(join(vault, note.path), "utf8");
    expect(after).toContain('status: "accepted"');
    expect(after).toContain('decided_on: "2026-09-30"');
    expect(after).toContain("Because of the MCP SDK.");
  });

  it("rejects fields outside the route allowlist, protected fields, bodies, and multi-line values", async () => {
    const { kernel } = await planningFixture();
    await kernel.applyWrite(write({ requestId: "project-0001", operation: "create", route: "project", title: "Alpha", body: "x" }));
    const note = await kernel.readNote("test", "projects/2026-09-30-alpha.md");
    const base = write({ requestId: "project-0002", operation: "set_frontmatter", route: "project", targetPath: note.path, expectedSha256: note.sha256 });
    await expect(kernel.previewWrite({ ...base, fields: { horizon: "long" } })).rejects.toThrow(/does not allow setting horizon/);
    await expect(kernel.previewWrite({ ...base, fields: { ai_access: "context" } })).rejects.toThrow(/does not allow setting ai_access/);
    await expect(kernel.previewWrite({ ...base, fields: { status: "done" }, body: "x" })).rejects.toThrow(/body is not accepted/);
    await expect(kernel.previewWrite({ ...base, fields: {} })).rejects.toThrow(/fields is required/);
    await expect(kernel.previewWrite({ ...base, fields: { next_action: "line one\nline two" } })).rejects.toThrow(/single line/);
    await expect(kernel.previewWrite({ ...base, operation: "append", body: "x", fields: { status: "done" } })).rejects.toThrow(/only accepted for create and set_frontmatter/);
  });

  it("refuses protected fields in a route config", async () => {
    const { root } = await fixture();
    const { loadConfig } = await import("./index.js");
    await writeFile(join(root, "c.json"), JSON.stringify({ version: 1, vaults: [{ id: "v", kind: "personal", path: "./v", mode: "read-write", routes: { r: { folder: "r", type: "note", status: "active", area: "x", fields: ["ai_access"] } } }] }));
    await expect(loadConfig(join(root, "c.json"))).rejects.toThrow(/protected field/);
  });

  it("sets allowed fields on create", async () => {
    const { kernel, vault } = await planningFixture();
    await kernel.applyWrite(write({ requestId: "daily-0001", operation: "create", route: "daily", title: "Circle", body: "## Day summary\n\nGood.", fields: { energy: 4, circle: "done" } }));
    const after = await readFile(join(vault, "daily/2026-09-30.md"), "utf8");
    expect(after).toMatch(/source_date: "2026-09-30"\nenergy: 4\ncircle: "done"\n---/);
    await expect(kernel.previewWrite(write({ requestId: "daily-0002", operation: "create", route: "session", title: "S", body: "x", fields: { energy: 1 } }))).rejects.toThrow(/does not allow setting energy/);
  });
});

describe("periodic notes", () => {
  it("keeps one weekly and one monthly note per period and looks them up by date", async () => {
    const { kernel } = await planningFixture();
    await expect(kernel.periodNote("test", { route: "review", date: "2026-10-01" })).resolves.toMatchObject({ exists: false, path: "reviews/2026-W40.md", key: "2026-W40", start: "2026-09-28", end: "2026-10-04", period: "week" });
    await kernel.applyWrite(write({ requestId: "week-0001", operation: "create", route: "review", title: "Week 40", body: "x", sourceDate: "2026-09-29" }));
    await expect(kernel.applyWrite(write({ requestId: "week-0002", operation: "create", route: "review", title: "Another title", body: "x", sourceDate: "2026-10-04" }))).rejects.toThrow(/already exists: reviews\/2026-W40.md/);
    await expect(kernel.periodNote("test", { period: "week", date: "2026-10-04" })).resolves.toMatchObject({ exists: true, route: "review" });
    await kernel.applyWrite(write({ requestId: "month-0001", operation: "create", route: "monthly", title: "September", body: "x" }));
    await expect(kernel.periodNote("test", { period: "month", date: "2026-09-01" })).resolves.toMatchObject({ exists: true, path: "reviews/2026-09.md" });
  });

  it("asks for a route when the request is ambiguous", async () => {
    const { kernel, config } = await planningFixture();
    config.vaults[0]!.routes.other = { folder: "other", type: "weekly-review", status: "active", area: "x", policy: "auto", period: "week", fields: [] };
    await expect(kernel.periodNote("test", { period: "week" })).rejects.toThrow(/Several weekly routes exist; pass route/);
    await expect(kernel.periodNote("test", { period: "quarter" })).rejects.toThrow(/no quarterly route/);
    await expect(kernel.periodNote("test", { route: "review" })).resolves.toMatchObject({ date: "2026-09-30", key: "2026-W40" });
  });
});

describe("note listing", () => {
  it("filters by frontmatter, folder, and updated date, and skips ignored and hidden notes", async () => {
    const { kernel, vault } = await planningFixture();
    const projectNote = (status: string, updated: string, access = "context") => `---\nid: x\ntype: project\nstatus: ${status}\narea: work\nprivacy: personal\nai_access: ${access}\nupdated: "${updated}"\n---\n\n# Project ${status}\n`;
    await mkdir(join(vault, "projects"));
    await mkdir(join(vault, "_templates"));
    await writeFile(join(vault, "projects/a.md"), projectNote("active", "2026-09-01"), "utf8");
    await writeFile(join(vault, "projects/b.md"), projectNote("active", "2026-09-29"), "utf8");
    await writeFile(join(vault, "projects/c.md"), projectNote("done", "2026-09-01"), "utf8");
    await writeFile(join(vault, "projects/hidden.md"), projectNote("active", "2026-09-01", "none"), "utf8");
    await writeFile(join(vault, "_templates/Project.md"), projectNote("active", "2026-01-01"), "utf8");

    const active = await kernel.listNotes("test", { type: "project", status: "active" });
    expect(active.map((note) => note.path)).toEqual(["projects/a.md", "projects/b.md"]);
    expect(active[0]).toMatchObject({ title: "Project active", frontmatter: { area: "work", updated: "2026-09-01" } });
    expect((await kernel.listNotes("test", { type: "project", status: "active", updatedBefore: "2026-09-15" })).map((note) => note.path)).toEqual(["projects/a.md"]);
    expect((await kernel.listNotes("test", { folder: "projects/", limit: 1 }))).toHaveLength(1);
  });
});

describe("open tasks", () => {
  it("collects open tasks across notes, sorted by due date then priority, and honors filters and access", async () => {
    const { kernel, vault } = await planningFixture();
    await mkdir(join(vault, "projects"));
    await writeFile(join(vault, "projects/alpha.md"), `${frontmatter()}\n# Alpha\n\n- [ ] Later 📅 2026-10-10\n- [ ] Soon 📅 2026-10-02 🔼\n- [x] Done 📅 2026-09-01\n- [ ] Someday\n`, "utf8");
    await writeFile(join(vault, "projects/beta.md"), `${frontmatter()}\n# Beta\n\n- [/] Urgent 📅 2026-10-02 ⏫\n`, "utf8");
    await writeFile(join(vault, "projects/secret.md"), `${frontmatter("none")}\n# Secret\n\n- [ ] Hidden 📅 2026-09-30\n`, "utf8");

    const all = await kernel.openTasks({ vaultId: "test" });
    expect(all.map((task) => task.text)).toEqual(["Urgent", "Soon", "Later", "Someday"]);
    expect(all[0]).toMatchObject({ path: "projects/beta.md", line: 12, status: "in-progress", priority: "high" });
    expect((await kernel.openTasks({ vaultId: "test", dueBy: "2026-10-05" })).map((task) => task.text)).toEqual(["Urgent", "Soon", "Someday"]);
    expect((await kernel.openTasks({ vaultId: "test", dueBy: "2026-10-05", includeUndated: false })).map((task) => task.text)).toEqual(["Urgent", "Soon"]);
    expect((await kernel.openTasks({ vaultId: "test", path: "projects/alpha.md" }))).toHaveLength(3);
    await expect(kernel.openTasks({ vaultId: "test", path: "projects/secret.md" })).rejects.toThrow(/excluded/);
  });
});

describe("search terms", () => {
  it("matches every term in any order, folds case and accents, and filters by type", async () => {
    const { kernel, vault } = await planningFixture();
    await writeFile(join(vault, "plan.md"), "---\nid: p\ntype: plan\nstatus: active\n---\n\n# Plan\n\nİstanbul ofisi için çalışma planı.\nBütçe ayrı.\n", "utf8");
    await writeFile(join(vault, "other.md"), "---\nid: o\ntype: note\nstatus: active\n---\n\n# Other\n\nSadece istanbul.\n", "utf8");
    expect((await kernel.search("calisma istanbul", "test")).map((hit) => hit.path)).toEqual(["plan.md"]);
    expect((await kernel.search("ISTANBUL", "test")).map((hit) => hit.path).sort()).toEqual(["other.md", "plan.md"]);
    expect((await kernel.search("istanbul", "test", 20, false, { type: "note" })).map((hit) => hit.path)).toEqual(["other.md"]);
  });
});

describe("ai_access parsing", () => {
  it("reads the value through YAML, allows trailing comments, and treats unknown values as restricted", async () => {
    const { kernel, vault } = await fixture();
    await writeFile(join(vault, "comment.md"), "---\nid: c\nai_access: none # private\n---\n\nneedle\n", "utf8");
    await writeFile(join(vault, "typo.md"), "---\nid: t\nai_access: nnone\n---\n\nneedle\n", "utf8");
    await expect(kernel.readNote("test", "comment.md", true)).rejects.toThrow(/excluded/);
    await expect(kernel.readNote("test", "typo.md")).rejects.toThrow(/explicit restricted/);
    await expect(kernel.search("needle", "test")).resolves.toEqual([]);
  });
});

describe("layout migration", () => {
  async function layoutTwoVault() {
    const f = await fixture();
    await mkdir(join(f.vault, ".lifekernel"));
    await mkdir(join(f.vault, "_templates"));
    await writeFile(join(f.vault, ".lifekernel/vault.json"), '{ "specVersion": 1, "layoutVersion": 2, "kind": "personal" }', "utf8");
    await writeFile(join(f.vault, "_templates/Daily.md"), '---\nid: "{{id}}"\ntype: "daily"\nenergy: "kept"\n---\n\n# {{date}}\n', "utf8");
    return f;
  }

  it("reports first, then adds the daily fields and bumps the layout once", async () => {
    const { kernel, vault } = await layoutTwoVault();
    const report = await kernel.migrate("test");
    expect(report).toEqual({ vaultId: "test", from: 2, to: 3, applied: false, changes: [
      { path: "_templates/Daily.md", change: "add frontmatter fields focus_hours, morning_plan, circle, circle_at" },
      { path: ".lifekernel/vault.json", change: "layoutVersion 2 -> 3" }
    ] });
    expect(await readFile(join(vault, "_templates/Daily.md"), "utf8")).not.toContain("circle");

    await expect(kernel.migrate("test", { apply: true })).resolves.toMatchObject({ applied: true });
    const template = await readFile(join(vault, "_templates/Daily.md"), "utf8");
    expect(template).toContain('energy: "kept"\nfocus_hours: ""\nmorning_plan: ""\ncircle: ""\ncircle_at: ""\n---');
    expect(JSON.parse(await readFile(join(vault, ".lifekernel/vault.json"), "utf8"))).toEqual({ specVersion: 1, layoutVersion: 3, kind: "personal" });
    await expect(kernel.migrate("test", { apply: true })).resolves.toEqual({ vaultId: "test", from: 3, to: 3, changes: [], applied: false });
    expect((await kernel.recentAudit(5)).filter((event) => event.event === "vault_migrated")).toHaveLength(1);
  });

  it("adds the ritual schedule keys, the morning section, and missing starter templates", async () => {
    const { kernel, vault, root } = await layoutTwoVault();
    await writeFile(join(vault, "_templates/Daily.md"), '---\r\nid: "{{id}}"\r\n---\r\n\r\n# {{date}}\r\n\r\n## Day summary\r\n', "utf8");
    await mkdir(join(vault, "system"));
    await writeFile(join(vault, "system/Method.md"), '---\nid: "m"\ndaily_circle_time: "21:00"\n---\n\n# Method\n\nThemed days.\n', "utf8");
    const starter = join(root, "starter");
    await mkdir(join(starter, "_templates"), { recursive: true });
    await writeFile(join(starter, "_templates/Daily.md"), "starter daily", "utf8");
    await writeFile(join(starter, "_templates/Monthly Review.md"), "monthly", "utf8");

    const report = await kernel.migrate("test", { apply: true, starterDir: starter });
    expect(report.changes).toEqual([
      { path: "_templates/Daily.md", change: "add frontmatter fields energy, focus_hours, morning_plan, circle, circle_at; add section Plan for today" },
      { path: "system/Method.md", change: "add frontmatter fields morning_plan_time, morning_plan_days, daily_circle_days, weekly_review_day, weekly_review_time, monthly_review_day, monthly_review_time, quarterly_review_day, quarterly_review_time, quiet_hours" },
      { path: "_templates/Monthly Review.md", change: "add template" },
      { path: ".lifekernel/vault.json", change: "layoutVersion 2 -> 3" }
    ]);
    const daily = await readFile(join(vault, "_templates/Daily.md"), "utf8");
    expect(daily).toContain("# {{date}}\r\n\r\n## Plan for today\r\n\r\n## Day summary\r\n");
    expect(daily.replaceAll("\r\n", "")).not.toContain("\n");
    const method = await readFile(join(vault, "system/Method.md"), "utf8");
    expect(method).toContain('daily_circle_time: "21:00"');
    expect(method).toContain('quiet_hours: ""');
    expect(method).toContain("Themed days.");
    expect(await readFile(join(vault, "_templates/Monthly Review.md"), "utf8")).toBe("monthly");
  });

  it("refuses folders that lifekernel init did not create", async () => {
    const { kernel } = await fixture();
    await expect(kernel.migrate("test")).rejects.toThrow(/not created by lifekernel init/);
  });
});

describe("rituals", () => {
  // Thursday 2026-10-01, 22:00 in Istanbul.
  const at = new Date("2026-10-01T19:00:00Z");
  const fm = (fields: string) => `---\nid: x\ntype: note\nstatus: active\narea: life\nprivacy: personal\nai_access: context\n${fields}---\n`;

  async function ritualFixture() {
    const f = await planningFixture();
    f.config.timezone = "Europe/Istanbul";
    const kernel = new LifeKernel(f.config, { now: () => at });
    const file = (path: string, content: string) => mkdir(join(f.vault, dirname(path)), { recursive: true }).then(() => writeFile(join(f.vault, path), content, "utf8"));
    await file("system/Method.md", fm('daily_circle_time: "21:30"\nmorning_plan_time: "08:30"\nmorning_plan_days: "weekdays"\nweekly_review_day: "sun"\nweekly_review_time: "20:00"\nquiet_hours: "23:00-08:00"\n') + "\n# Planning method\n");
    await file("daily/2026-09-29.md", fm('energy: 2\nfocus_hours: 1.5\ncircle: "done"\n') + "\n# 2026-09-29\n");
    await file("daily/2026-09-30.md", fm('energy: 4\nfocus_hours: 3\ncircle: "done"\nmorning_plan: "done"\n') + "\n# 2026-09-30\n\n## Open loops\n\nCall the bank.\n\n## Tomorrow's focus\n\nShip the pricing page.\n");
    await file("daily/2026-10-01.md", fm('morning_plan: "done"\n') + "\n# 2026-10-01\n\n## Plan for today\n\nPricing page, then gym.\n");
    await file("schedule/Availability.md", fm("") + "\n# Availability\n\n## Fixed commitments\n\n| Day | Time | Commitment |\n| --- | --- | --- |\n| Thu | 18:00 | Gym |\n| Weekdays | 09:00-17:00 | Work |\n| Sat | 10:00 | Market |\n\n## Flexible windows\n");
    await file("schedule/Near-Term Plan.md", fm("") + "\n# Near-term plan\n\n## Focus for tomorrow\n\nPricing page.\n\n## This week\n\nLaunch beta.\n");
    await file("schedule/Capacity.md", fm("") + "\n# Capacity\n\n## Stated capacity\n\n- Focused work hours per weekday: 4\n\n## Observed capacity\n");
    await file("projects/launch.md", `---\nid: l\ntype: project\nstatus: active\narea: work\nupdated: "2026-09-29"\n---\n\n# Launch\n\n## Tasks\n\n- [ ] Pricing page 📅 2026-10-01\n- [ ] Old bug 📅 2026-09-25 ⏫\n- [x] Domain ✅ 2026-09-29\n`);
    await file("projects/stale.md", `---\nid: s\ntype: project\nstatus: active\narea: work\nupdated: "2026-09-01"\n---\n\n# Stale\n`);
    await file("goals/fit.md", `---\nid: g\ntype: goal\nstatus: active\nhorizon: short\n---\n\n# Get fit\n\n## Linked projects and areas\n\n- [[projects/launch]]\n`);
    await file("goals/lonely.md", `---\nid: g2\ntype: goal\nstatus: active\nhorizon: long\n---\n\n# Write a book\n\n## Linked projects and areas\n\n- [[projects/stale-idea]]\n`);
    return { ...f, kernel };
  }

  it("reports each ritual from the method schedule and the daily fields", async () => {
    const { kernel } = await ritualFixture();
    const report = await kernel.ritualStatus("test");
    expect(report).toMatchObject({ now: "2026-10-01T22:00:00+03:00", date: "2026-10-01", timeZone: "Europe/Istanbul", quietHours: { start: "23:00", end: "08:00" } });
    const byId = Object.fromEntries(report.rituals.map((status) => [status.id, status]));
    expect(byId["daily-circle"]).toMatchObject({ state: "due", streak: 2, lastDone: "2026-09-30", dueAt: "2026-10-01T21:30:00+03:00" });
    expect(byId["morning-plan"]).toMatchObject({ state: "done", streak: 2 });
    // The vault's first daily note is 2026-09-29, so the week before does not count as missed.
    expect(byId["weekly-review"]).toEqual({ id: "weekly-review", state: "upcoming", period: "2026-W40", dueAt: "2026-10-04T20:00:00+03:00", schedule: "sun 20:00" });
    expect(byId["monthly-review"]).toEqual({ id: "monthly-review", state: "not-scheduled" });
  });

  it("marks a weekly review complete through its status, and includes rituals in today's context bundle", async () => {
    const { kernel } = await ritualFixture();
    await kernel.applyWrite(write({ requestId: "ritual-0001", operation: "create", route: "review", title: "Week 40", body: "x", sourceDate: "2026-10-01" }));
    const note = await kernel.periodNote("test", { period: "week" });
    expect((await kernel.ritualStatus("test")).rituals.find((status) => status.id === "weekly-review")).toMatchObject({ state: "upcoming" });
    await kernel.applyWrite(write({ requestId: "ritual-0002", operation: "set_frontmatter", route: "review", targetPath: note.path, expectedSha256: note.exists ? note.sha256 : "", fields: { status: "complete" }, sourceDate: "2026-10-01" }));
    expect((await kernel.ritualStatus("test")).rituals.find((status) => status.id === "weekly-review")).toMatchObject({ state: "done", lastDone: "2026-W40" });
    expect((await kernel.contextBundle("test")).rituals?.rituals).toHaveLength(5);
    expect((await kernel.contextBundle("test", { date: "2026-09-30" })).rituals).toBeUndefined();
  });

  it("reports an unreadable method note instead of failing", async () => {
    const { kernel, vault } = await ritualFixture();
    await writeFile(join(vault, "system/Method.md"), fm("").replace("ai_access: context", "ai_access: none") + "\n# Method\n", "utf8");
    const report = await kernel.ritualStatus("test");
    expect(report.error).toMatch(/excluded from AI access/);
    expect(report.rituals.every((status) => status.state === "not-scheduled")).toBe(true);
  });

  it("prepares the morning plan from yesterday, the plan, today's commitments, and due tasks", async () => {
    const { kernel } = await ritualFixture();
    const agenda = await kernel.ritualAgenda("test", "morning-plan") as Record<string, unknown>;
    expect(agenda).toMatchObject({
      date: "2026-10-01",
      yesterday: { date: "2026-09-30", circle: "done" },
      yesterdayFocus: { source: "daily/2026-09-30.md", text: "Ship the pricing page." },
      openLoops: { source: "daily/2026-09-30.md", text: "Call the bank." },
      plannedFocus: { source: "schedule/Near-Term Plan.md", text: "Pricing page." },
      tasks: { overdue: [expect.objectContaining({ text: "Old bug", path: "projects/launch.md" })], dueToday: [expect.objectContaining({ text: "Pricing page" })] }
    });
    expect((agenda.commitments as Array<{ commitment: string }>).map((row) => row.commitment)).toEqual(["Gym", "Work"]);
  });

  it("prepares the daily circle with today's plan and a catch-up for a missed day", async () => {
    const { kernel } = await ritualFixture();
    expect(await kernel.ritualAgenda("test", "daily-circle")).toMatchObject({ planForToday: "Pricing page, then gym.", catchUp: null, thisWeek: { text: "Launch beta." } });
    expect(await kernel.ritualAgenda("test", "daily-circle", { date: "2026-09-29" })).toMatchObject({ catchUp: { date: "2026-09-28", noteExists: false }, planForToday: null });
  });

  it("prepares the weekly review from the week's fields, tasks, and projects", async () => {
    const { kernel } = await ritualFixture();
    const agenda = await kernel.ritualAgenda("test", "weekly-review") as Record<string, unknown>;
    expect(agenda).toMatchObject({
      period: { key: "2026-W40", start: "2026-09-28", end: "2026-10-04" },
      reviewNote: { key: "2026-W40", path: "reviews/2026-W40.md", exists: false },
      stats: { days: 7, daysRecorded: 3, circlesDone: 2, averageEnergy: 3, focusHours: 4.5 },
      completedTasks: [expect.objectContaining({ text: "Domain", done: "2026-09-29" })],
      stalledProjects: [{ path: "projects/stale.md", title: "Stale", updated: "2026-09-01" }],
      statedCapacity: { text: "- Focused work hours per weekday: 4" },
      observedCapacity: null
    });
    expect((agenda.overdueTasks as Array<{ text: string }>).map((task) => task.text)).toEqual(["Old bug", "Pricing page"]);
  });

  it("prepares monthly and quarterly reviews with goals that lack an active project", async () => {
    const { kernel } = await ritualFixture();
    const monthly = await kernel.ritualAgenda("test", "monthly-review") as { goals: Array<{ title: string; activeProjects: number }>; weeklyReviews: Array<{ key: string }> };
    expect(monthly.goals).toEqual([
      expect.objectContaining({ title: "Get fit", horizon: "short", activeProjects: 1 }),
      expect.objectContaining({ title: "Write a book", horizon: "long", activeProjects: 0 })
    ]);
    expect(monthly.weeklyReviews.map((review) => review.key)).toEqual(["2026-W40", "2026-W41", "2026-W42", "2026-W43", "2026-W44"]);
    const quarterly = await kernel.ritualAgenda("test", "quarterly-review") as { period: { key: string }; monthlyReviews: Array<{ key: string }> };
    expect(quarterly.period.key).toBe("2026-Q4");
    expect(quarterly.monthlyReviews).toEqual([
      { key: "2026-10", path: "reviews/2026-10.md", exists: false, status: null },
      { key: "2026-11", path: "reviews/2026-11.md", exists: false, status: null },
      { key: "2026-12", path: "reviews/2026-12.md", exists: false, status: null }
    ]);
    await expect(kernel.ritualAgenda("test", "evening" as never)).rejects.toThrow(/Unknown ritual/);
  });
});

describe("config files", () => {
  it("explains a missing config instead of failing with ENOENT", async () => {
    const { root } = await fixture();
    const { loadConfig } = await import("./index.js");
    await expect(loadConfig(join(root, "missing.json"))).rejects.toThrow(/No config at .*missing\.json\. Run "npm run cli -- init"/);
  });

  it("loads a .env beside the config without overriding variables already set", async () => {
    const { root } = await fixture();
    const { loadEnvBeside } = await import("./index.js");
    await writeFile(join(root, ".env"), "# reminders\nLIFEKERNEL_NTFY_TOPIC=lk-topic\nALREADY=from-file\nQUOTED=\"two words\"\n", "utf8");
    const env: NodeJS.ProcessEnv = { ALREADY: "from-shell" };
    expect(await loadEnvBeside(join(root, "lifekernel.config.json"), env)).toEqual(["LIFEKERNEL_NTFY_TOPIC", "QUOTED"]);
    expect(env).toEqual({ ALREADY: "from-shell", LIFEKERNEL_NTFY_TOPIC: "lk-topic", QUOTED: "two words" });
    expect(await loadEnvBeside(join(root, "elsewhere", "c.json"), {})).toEqual([]);
  });
});

describe("rollup routes", () => {
  async function rollupFixture() {
    const f = await planningFixture();
    f.config.vaults[0]!.routes.outcome = { folder: "outcomes", type: "outcome", status: "active", area: "work", policy: "auto", rollup: true, fields: ["status"] };
    return f;
  }
  const outcome = (requestId: string, body: string) => write({ requestId, operation: "create", route: "outcome", title: "Shipped pricing", body, source: "startup project agent" });

  it("accepts a short outcome that links to the detailed record, and shows it in the weekly review", async () => {
    const { kernel } = await rollupFixture();
    await kernel.applyWrite(outcome("outcome-0001", "Pricing page is live; details in startup:sessions/2026-09-30-pricing.md"));
    expect(kernel.listVaults()[0]!.routes.find((route) => route.name === "outcome")).toMatchObject({ rollup: true });
    const agenda = await kernel.ritualAgenda("test", "weekly-review", { date: "2026-09-30" }) as { outcomes: unknown[] };
    expect(agenda.outcomes).toEqual([{ path: "outcomes/2026-09-30-shipped-pricing.md", title: "Shipped pricing", source: "startup project agent" }]);
  });

  it("refuses long or unlinked outcomes and edits to the body", async () => {
    const { kernel } = await rollupFixture();
    await expect(kernel.previewWrite(outcome("outcome-0002", "Done."))).rejects.toThrow(/needs a link/);
    await expect(kernel.previewWrite(outcome("outcome-0003", `${"x".repeat(600)} [[Source]]`))).rejects.toThrow(/at most 600/);
    for (const body of ["See [[sessions/pricing]]", "See https://example.com/pr/1", "See work:projects/launch.md"]) {
      await expect(kernel.previewWrite(outcome(`outcome-${body.length}xx`, body))).resolves.toMatchObject({ operation: "create" });
    }
    await kernel.applyWrite(outcome("outcome-0004", "Linked [[Source]]"));
    const note = await kernel.readNote("test", "outcomes/2026-09-30-shipped-pricing.md");
    await expect(kernel.previewWrite(write({ requestId: "outcome-0005", operation: "append", route: "outcome", targetPath: note.path, expectedSha256: note.sha256, body: "More detail" }))).rejects.toThrow(/short outcomes only/);
    await expect(kernel.previewWrite(write({ requestId: "outcome-0006", operation: "set_frontmatter", route: "outcome", targetPath: note.path, expectedSha256: note.sha256, fields: { status: "done" } }))).resolves.toMatchObject({ operation: "set_frontmatter" });
  });
});
