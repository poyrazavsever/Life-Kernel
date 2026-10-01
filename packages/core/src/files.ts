import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;

export interface LockOptions {
  /** How long to wait for a busy lock before giving up. */
  timeoutMs?: number;
  /** A lock whose file has not been touched this long belongs to a process that died. */
  staleMs?: number;
  /** While work runs, the holder touches the lock this often, so slow work never looks stale. */
  heartbeatMs?: number;
}

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

const ageOf = (path: string) => stat(path).then((info) => Date.now() - info.mtimeMs, () => Number.POSITIVE_INFINITY);

/**
 * Run `work` while holding a lock file shared by every Life Kernel process on this state directory.
 *
 * The holder keeps the file's modification time fresh, so only a lock whose owner died goes stale. A stale
 * lock is taken over by renaming it away, which only one contender can win; if what was renamed turns out to
 * be fresh after all (its owner renewed it in the meantime), it is put back. A holder releases only a lock
 * that still carries its own token, so it can never delete one that someone else now owns.
 */
export async function withFileLock<T>(lockPath: string, busy: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(12).toString("hex");
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await ageOf(lockPath) > staleMs) {
      const grave = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
      try { await rename(lockPath, grave); } catch { continue; } // another contender took it first
      if (await ageOf(grave) > staleMs) await rm(grave, { force: true });
      else { await link(grave, lockPath).catch(() => undefined); await rm(grave, { force: true }); }
      continue;
    }
    if (Date.now() > deadline) throw new Error(busy);
    await delay(20 + Math.floor(Math.random() * 40));
  }
  const beat = setInterval(() => { const now = new Date(); utimes(lockPath, now, now).catch(() => undefined); }, heartbeatMs);
  beat.unref();
  try { return await work(); } finally {
    clearInterval(beat);
    const held = await readFile(lockPath, "utf8").then((text) => (JSON.parse(text) as { token?: string }).token, () => undefined);
    if (held === token) await rm(lockPath, { force: true });
  }
}
