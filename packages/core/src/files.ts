import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

/** Write through a temporary sibling and rename it, so a crash never leaves a half-written file. */
export async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, content, "utf8");
  try { await rename(temporary, path); } catch (error: unknown) {
    // Windows refuses to replace a file another program holds open; fall back to an in-place write.
    if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await rm(temporary, { force: true });
    await writeFile(path, content, "utf8");
  }
}

/**
 * Run `work` while holding a lock file shared by every Life Kernel process on this state directory.
 * A process that crashed while holding the lock leaves it behind; it is taken over once it is clearly stale.
 */
export async function withFileLock<T>(lockPath: string, busy: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => 0);
    if (age > LOCK_STALE_MS) { await rm(lockPath, { force: true }); continue; }
    if (Date.now() > deadline) throw new Error(busy);
    await delay(20 + Math.floor(Math.random() * 40));
  }
  try { return await work(); } finally { await rm(lockPath, { force: true }); }
}
