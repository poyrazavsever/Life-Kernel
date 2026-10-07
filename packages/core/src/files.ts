import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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

const WINDOWS_RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_RENAME_ATTEMPTS = 5;

const shouldRetryRename = (error: unknown) =>
  process.platform === "win32" &&
  WINDOWS_RENAME_RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? "");

/** Write through a temporary sibling and rename it, so a crash never leaves a half-written file. */
export async function replaceFile(
  path: string,
  content: string,
  renameFile: typeof rename = rename,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, content, "utf8");
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await renameFile(temporary, path);
        return;
      } catch (error: unknown) {
        if (!shouldRetryRename(error) || attempt >= WINDOWS_RENAME_ATTEMPTS) throw error;
        await delay(Math.min(20 * 2 ** (attempt - 1), 200));
      }
    }
  } catch (error: unknown) {
    // Fail closed if the destination remains unavailable. An in-place fallback can truncate a note.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Age of a file in milliseconds, or undefined when it does not exist. */
const ageOf = (path: string) => stat(path).then((info) => Date.now() - info.mtimeMs, () => undefined);

// Creating a file that exists, or that another process is deleting, fails with EEXIST; Windows reports the
// delete-pending case as EPERM, EACCES, or EBUSY. All of them mean "someone else has it": wait and retry.
const CONTENDED = new Set(["EEXIST", ...(process.platform === "win32" ? ["EPERM", "EACCES", "EBUSY"] : [])]);
const isContended = (error: unknown) => CONTENDED.has((error as NodeJS.ErrnoException).code ?? "");

/**
 * Remove a lock left by a dead process. Two contenders must never both remove "the" stale lock, because the
 * second could delete a fresh lock that the first one's winner has just created. A short takeover lock makes
 * the check and the removal one step: while it is held, the stale file stays in place, so nobody can create
 * a new lock until it is gone.
 */
async function removeStale(lockPath: string, staleMs: number): Promise<void> {
  const takeover = `${lockPath}.takeover`;
  let handle;
  try { handle = await open(takeover, "wx"); } catch (error: unknown) {
    if (!isContended(error)) throw error;
    // Whoever held the takeover lock may have died too.
    const age = await ageOf(takeover);
    if (age !== undefined && age > staleMs) await rm(takeover, { force: true });
    return;
  }
  try {
    const age = await ageOf(lockPath);
    if (age !== undefined && age > staleMs) await rm(lockPath, { force: true });
  } finally {
    await handle.close();
    await rm(takeover, { force: true });
  }
}

/**
 * Run `work` while holding a lock file shared by every Life Kernel process on this state directory.
 *
 * The holder keeps the file's modification time fresh, so only a lock whose owner died goes stale. A stale
 * lock is removed under a takeover lock (see removeStale). A holder releases only a lock that still carries
 * its own token, so it never deletes one that someone else owns.
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
      if (!isContended(error)) throw error;
    }
    const age = await ageOf(lockPath);
    if (age === undefined) continue; // released in the meantime
    if (age > staleMs) { await removeStale(lockPath, staleMs); continue; }
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
