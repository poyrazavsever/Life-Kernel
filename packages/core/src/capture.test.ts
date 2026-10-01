import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capture, inboxItems } from "./capture.js";
import { LifeKernel, type LifeKernelConfig } from "./index.js";

async function setup(inbox: Record<string, unknown> = { period: "day", fields: ["status"] }) {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-capture-"));
  const vault = join(root, "vault");
  await mkdir(vault);
  const config: LifeKernelConfig = {
    version: 1, stateDir: join(root, "state"), timezone: "Europe/Istanbul",
    vaults: [{ id: "personal", kind: "personal", path: vault, mode: "read-write", routes: {
      daily: { folder: "daily", type: "daily", status: "active", area: "life", policy: "auto" },
      inbox: { folder: "inbox", type: "note", status: "inbox", area: "system", policy: "auto", ...inbox }
    } }]
  };
  const at = new Date("2026-10-01T18:40:00Z");
  return { vault, kernel: new LifeKernel(config, { now: () => at }), at };
}

describe("capture", () => {
  it("appends to one inbox note per day with the local time and source, and stays apart from the daily note", async () => {
    const { kernel, vault, at } = await setup();
    await capture(kernel, "personal", "Call the accountant\nabout Q4", { source: "cli", at });
    await capture(kernel, "personal", "Book the dentist", { source: "telegram", at: new Date("2026-10-01T19:05:00Z") });
    const note = await readFile(join(vault, "inbox/2026-10-01.md"), "utf8");
    expect(note).toContain("- 21:40 Call the accountant about Q4 (cli)\n\n- 22:05 Book the dentist (telegram)");
    expect(note).toContain('status: "inbox"');
    await expect(kernel.dailyNote("personal", "2026-10-01")).resolves.toMatchObject({ path: "daily/2026-10-01.md", exists: false });
  });

  it("does not write a redelivered message twice", async () => {
    const { kernel, vault, at } = await setup();
    const first = await capture(kernel, "personal", "Once", { source: "telegram", requestId: "telegram-1001", at });
    const again = await capture(kernel, "personal", "Once", { source: "telegram", requestId: "telegram-1001", at });
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    await capture(kernel, "personal", "Second", { source: "telegram", requestId: "telegram-1002", at });
    expect(await capture(kernel, "personal", "Second", { source: "telegram", requestId: "telegram-1002", at })).toMatchObject({ duplicate: true });
    expect((await readFile(join(vault, "inbox/2026-10-01.md"), "utf8")).match(/Once/g)).toHaveLength(1);
  });

  it("handles captures racing from several devices", async () => {
    const { kernel, vault, at } = await setup();
    await Promise.all(["one", "two", "three"].map((text, index) => capture(kernel, "personal", text, { source: "phone", at: new Date(at.getTime() + index * 60_000) })));
    const note = await readFile(join(vault, "inbox/2026-10-01.md"), "utf8");
    for (const text of ["one", "two", "three"]) expect(note).toContain(`${text} (phone)`);
  });

  it("reopens a triaged inbox note when a new item arrives, and lists open items", async () => {
    const { kernel, at } = await setup();
    await capture(kernel, "personal", "First thought", { source: "cli", at });
    const note = await kernel.periodNote("personal", { route: "inbox", date: "2026-10-01" });
    await kernel.applyWrite({ requestId: "triage-0001", vaultId: "personal", operation: "set_frontmatter", route: "inbox", targetPath: note.path, expectedSha256: note.exists ? note.sha256 : "", fields: { status: "processed" }, source: "daily circle", sourceDate: "2026-10-01" });
    expect(await inboxItems(kernel, "personal")).toEqual([]);
    await capture(kernel, "personal", "Late thought", { source: "cli", at: new Date("2026-10-01T19:30:00Z") });
    expect(await inboxItems(kernel, "personal")).toEqual([{ path: "inbox/2026-10-01.md", sha256: expect.any(String), items: ["21:40 First thought (cli)", "22:30 Late thought (cli)"] }]);
    expect(await kernel.ritualAgenda("personal", "daily-circle", { date: "2026-10-01" })).toMatchObject({ inbox: { count: 2 } });
  });

  it("creates one note per capture on a route without a period, and refuses empty or oversized text", async () => {
    const { kernel, at } = await setup({});
    expect((await capture(kernel, "personal", "Standalone idea", { source: "cli", at })).path).toBe("inbox/2026-10-01-standalone-idea.md");
    await expect(capture(kernel, "personal", "   ", { source: "cli", at })).rejects.toThrow(/Nothing to capture/);
    await expect(capture(kernel, "personal", "x".repeat(2001), { source: "cli", at })).rejects.toThrow(/limited to 2000/);
    await expect(capture(kernel, "personal", "x", { source: "cli", at, route: "missing" })).rejects.toThrow(/no missing route/);
  });
});
