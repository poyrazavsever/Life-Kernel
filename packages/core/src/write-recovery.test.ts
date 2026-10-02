import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { LifeKernel, type LifeKernelConfig } from "./index.js";
import * as files from "./files.js";
import { git } from "./history.js";

vi.mock("node:fs/promises", { spy: true });
vi.mock("./files.js", { spy: true });
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-recovery-"));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await mkdir(join(vault, "projects"), { recursive: true });
  await writeFile(join(vault, "projects/p.md"), "---\nid: p\nai_access: context\n---\n\n# Project\n\n## Next\n\nBefore\n");
  await git(vault, ["init", "--quiet"]);
  await git(vault, ["add", "."]);
  await git(vault, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--quiet", "-m", "Initial"]);
  const config: LifeKernelConfig = { version: 1, stateDir: state, timezone: "UTC", vaults: [{ id: "test", kind: "project", path: vault, mode: "read-write", history: "git", routes: { project: { folder: "projects", type: "project", status: "active", area: "work", policy: "auto" } } }] };
  const kernel = new LifeKernel(config);
  const note = await kernel.readNote("test", "projects/p.md");
  const request = { requestId: "recovery-audit-01", vaultId: "test", operation: "update_section", route: "project", targetPath: note.path, expectedSha256: note.sha256, section: "Next", body: "After", source: "test", sourceDate: "2026-10-02" };
  return { vault, state, config, kernel, request };
}

it("recovers audit and git history when audit append fails after the note was written", async () => {
  const { vault, config, kernel, request } = await setup();
  vi.mocked(fs.appendFile).mockRejectedValueOnce(new Error("Audit unavailable"));
  await expect(kernel.applyWrite(request, { client: { name: "original-client" } })).rejects.toThrow("Audit unavailable");
  const restarted = new LifeKernel(config);
  const recovered = await restarted.applyWrite(request, { client: { name: "retry-client" } });
  expect(recovered.history?.committed).toBe(true);
  const events = (await restarted.recentAudit(100)).filter(e => e.event === "write_applied");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ client: { name: "original-client" } });
  expect((await restarted.applyWrite(request)).replayed).toBe(true);
  expect((await git(vault, ["log", "--format=%s"])).trim().split("\n")).toHaveLength(2);
});

it("does not duplicate audit or git history when the final receipt cannot be saved", async () => {
  const { vault, config, kernel, request } = await setup();
  const { replaceFile: realReplace } = await vi.importActual<typeof import("./files.js")>("./files.js");
  vi.mocked(files.replaceFile).mockImplementation(async (path, content) => {
    if (path.endsWith(`${request.requestId}.json`) && JSON.parse(content).state === "applied") throw new Error("Receipt unavailable");
    return realReplace(path, content);
  });
  await expect(kernel.applyWrite(request)).rejects.toThrow("Receipt unavailable");
  vi.mocked(files.replaceFile).mockRestore();
  const restarted = new LifeKernel(config);
  expect((await restarted.applyWrite(request)).history?.committed).toBe(true);
  expect((await restarted.recentAudit(100)).filter(e => e.event === "write_applied")).toHaveLength(1);
  expect((await git(vault, ["log", "--format=%s"])).trim().split("\n")).toHaveLength(2);
  expect(await readFile(join(vault, "projects/p.md"), "utf8")).toContain("After");
});
