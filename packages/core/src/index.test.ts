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
