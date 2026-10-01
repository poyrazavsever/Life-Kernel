import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "./history.js";
import { LifeKernel, type LifeKernelConfig } from "./index.js";

async function setup(history = true, initRepo = true) {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-history-"));
  const vault = join(root, "vault");
  await mkdir(join(vault, "projects"), { recursive: true });
  await writeFile(join(vault, "projects/launch.md"), "---\nid: l\ntype: project\nstatus: active\n---\n\n# Launch\n\n## Next\n\nWrite copy.\n", "utf8");
  await writeFile(join(vault, "unrelated.md"), "# Unrelated\n", "utf8");
  if (initRepo) {
    await git(vault, ["init", "--quiet"]);
    await git(vault, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
    await git(vault, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "start"]);
  }
  const config: LifeKernelConfig = {
    version: 1, stateDir: join(root, "state"), timezone: "UTC",
    vaults: [{ id: "work", kind: "work", path: vault, mode: "read-write", ...(history ? { history: "git" as const } : {}), routes: {
      project: { folder: "projects", type: "project", status: "active", area: "p", policy: "auto", fields: ["status"] }
    } }]
  };
  return { vault, kernel: new LifeKernel(config, { now: () => new Date("2026-10-01T12:00:00Z") }) };
}

const update = async (kernel: LifeKernel, requestId: string, body: string) => {
  const note = await kernel.readNote("work", "projects/launch.md");
  return kernel.applyWrite({ requestId, vaultId: "work", operation: "update_section", route: "project", targetPath: note.path, section: "Next", expectedSha256: note.sha256, body, source: "agent", sourceDate: "2026-10-01" }, { client: { name: "coder" } });
};

describe("git history", () => {
  it("commits each write on its own path, naming the request and client but not the text", async () => {
    const { vault, kernel } = await setup();
    await writeFile(join(vault, "unrelated.md"), "# Unrelated, edited by hand\n", "utf8");
    const applied = await update(kernel, "history-0001", "Ship the landing page.");
    expect(applied.history).toMatchObject({ committed: true, commit: expect.stringMatching(/^[a-f0-9]{40}$/) });
    const message = await git(vault, ["log", "-1", "--format=%an%n%B"]);
    expect(message).toContain("Life Kernel\nlifekernel: update_section projects/launch.md");
    expect(message).toContain("request: history-0001");
    expect(message).toContain("client: coder");
    expect(message).not.toContain("landing page");
    expect(await git(vault, ["status", "--porcelain"])).toContain("unrelated.md");
  });

  it("undoes a write: a report first, then a new commit, and the note is back", async () => {
    const { vault, kernel } = await setup();
    const original = await readFile(join(vault, "projects/launch.md"), "utf8");
    await update(kernel, "history-0002", "Something wrong.");
    await expect(kernel.undo("history-0002")).resolves.toMatchObject({ applied: false, path: "projects/launch.md", operation: "update_section" });
    await expect(kernel.undo("history-0002", { apply: true })).resolves.toMatchObject({ applied: true, history: { committed: true } });
    expect(await readFile(join(vault, "projects/launch.md"), "utf8")).toBe(original);
    expect(await git(vault, ["log", "-1", "--format=%s"])).toContain("lifekernel: undo history-0002");
    expect((await kernel.recentAudit(1))[0]).toMatchObject({ event: "write_undone", requestId: "history-0002" });
  });

  it("refuses to undo over later edits, a create, an unknown request, or a vault without history", async () => {
    const { kernel } = await setup();
    await update(kernel, "history-0003", "First.");
    await update(kernel, "history-0004", "Second.");
    await expect(kernel.undo("history-0003", { apply: true })).rejects.toThrow(/changed after history-0003/);
    await kernel.applyWrite({ requestId: "history-0005", vaultId: "work", operation: "create", route: "project", title: "New", body: "x", source: "agent", sourceDate: "2026-10-01" });
    await expect(kernel.undo("history-0005")).rejects.toThrow(/would delete a note/);
    await expect(kernel.undo("history-9999")).rejects.toThrow(/No applied write/);
    const plain = await setup(false);
    await update(plain.kernel, "history-0006", "x");
    await expect(plain.kernel.undo("history-0006")).rejects.toThrow(/does not keep history/);
  });

  it("still writes when the vault is not a repository, and reports the failed commit", async () => {
    const { kernel } = await setup(true, false);
    const applied = await update(kernel, "history-0007", "Written anyway.");
    expect(applied.history).toMatchObject({ committed: false, error: expect.stringMatching(/git .* failed/) });
    expect((await kernel.recentAudit(1))[0]).toMatchObject({ event: "history_failed", requestId: "history-0007" });
    expect((await kernel.readNote("work", "projects/launch.md")).content).toContain("Written anyway.");
  });
});
