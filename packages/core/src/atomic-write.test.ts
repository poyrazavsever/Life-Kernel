import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { replaceFile } from "./files.js";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => vi.restoreAllMocks());

it("preserves the original file when Windows refuses an atomic replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-atomic-"));
  const path = join(root, "note.md");
  await writeFile(path, "Original complete note");
  vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("Locked"), { code: "EPERM" }));
  await expect(replaceFile(path, "Replacement")).rejects.toThrow("Locked");
  expect(await readFile(path, "utf8")).toBe("Original complete note");
});
