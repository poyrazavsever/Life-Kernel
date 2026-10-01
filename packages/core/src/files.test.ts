import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { withFileLock } from "./files.js";

const lockIn = async () => join(await mkdtemp(join(tmpdir(), "lifekernel-lock-")), "locks", "v.lock");

describe("withFileLock", () => {
  it("serializes concurrent work", async () => {
    const lock = await lockIn();
    let inside = 0;
    let overlapped = false;
    await Promise.all(Array.from({ length: 6 }, () => withFileLock(lock, "busy", async () => {
      inside += 1;
      if (inside > 1) overlapped = true;
      await delay(15);
      inside -= 1;
    })));
    expect(overlapped).toBe(false);
  });

  it("takes over a lock left by a dead process, once, even with many contenders", async () => {
    const lock = await lockIn();
    await withFileLock(lock, "busy", async () => undefined); // creates the directory
    await writeFile(lock, JSON.stringify({ token: "dead", pid: 1 }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    let inside = 0;
    let overlapped = false;
    let ran = 0;
    await Promise.all(Array.from({ length: 8 }, () => withFileLock(lock, "busy", async () => {
      inside += 1;
      if (inside > 1) overlapped = true;
      await delay(10);
      ran += 1;
      inside -= 1;
    }, { staleMs: 1_000 })));
    expect(ran).toBe(8);
    expect(overlapped).toBe(false);
  });

  it("keeps a slow holder's lock from looking stale", async () => {
    const lock = await lockIn();
    let intruded = false;
    const slow = withFileLock(lock, "busy", async () => { await delay(400); }, { staleMs: 150, heartbeatMs: 30 });
    await delay(60);
    // Without the heartbeat this would see a 150 ms-old lock as stale and run immediately.
    const other = withFileLock(lock, "busy", async () => { intruded = true; }, { staleMs: 150, heartbeatMs: 30, timeoutMs: 100 }).catch((error: Error) => error.message);
    expect(await other).toBe("busy");
    expect(intruded).toBe(false);
    await slow;
  });

  it("does not delete a lock that another process owns by the time it releases", async () => {
    const lock = await lockIn();
    await withFileLock(lock, "busy", async () => {
      await writeFile(lock, JSON.stringify({ token: "someone-else", pid: 2 })); // the lock was taken over
    });
    expect(JSON.parse(await readFile(lock, "utf8")).token).toBe("someone-else");
    await rm(lock, { force: true });
  });

  it("gives up with the busy message when the lock stays held", async () => {
    const lock = await lockIn();
    const holder = withFileLock(lock, "busy", async () => { await delay(300); });
    await delay(30);
    await expect(withFileLock(lock, "Vault is busy", async () => undefined, { timeoutMs: 80 })).rejects.toThrow("Vault is busy");
    await holder;
  });
});
