import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export interface HistoryResult { committed: boolean; commit?: string; error?: string }

const IDENTITY = ["-c", "user.name=Life Kernel", "-c", "user.email=lifekernel@localhost"];

/** Run git in a vault. Arguments go straight to git, never through a shell. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.find((arg) => !arg.startsWith("-")) ?? ""} failed: ${(stderr || error.message).trim().split("\n")[0]}`));
      else resolve(stdout);
    });
  });
}

/**
 * Commit the current state of some vault paths, and only those paths, so other work in the repository is
 * left alone. The message names the request and client but never contains note text.
 */
export async function commitPaths(vaultPath: string, paths: string[], subject: string, trailers: Record<string, string>): Promise<HistoryResult> {
  try {
    await git(vaultPath, ["add", "--", ...paths]);
    const message = `${subject}\n\n${Object.entries(trailers).map(([key, value]) => `${key}: ${value}`).join("\n")}`;
    await git(vaultPath, [...IDENTITY, "commit", "--quiet", "-m", message, "--", ...paths]);
    return { committed: true, commit: (await git(vaultPath, ["rev-parse", "HEAD"])).trim() };
  } catch (error: unknown) {
    return { committed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The commit that recorded a request, and the note's content just before it. */
export async function requestCommit(vaultPath: string, path: string, requestId: string): Promise<string | undefined> {
  // --grep matches substrings, so "request: abc-1" would also find a commit for "abc-12". Keep only commits
  // that carry exactly this ID on their own trailer line.
  const entries = (await git(vaultPath, ["log", "--format=%H%x1f%B%x1e", "--fixed-strings", `--grep=request: ${requestId}`, "--", path])).split("\x1e");
  const log = entries
    .map((entry) => entry.trim().split("\x1f"))
    .filter(([hash, body]) => hash && (body ?? "").split(/\r?\n/).some((line) => line.trim() === `request: ${requestId}`))
    .map(([hash]) => hash!);
  return log[log.length - 1];
}

export async function contentBefore(vaultPath: string, path: string, requestId: string): Promise<{ commit: string; content: string }> {
  const commit = await requestCommit(vaultPath, path, requestId);
  if (!commit) throw new Error(`No commit records ${requestId}; history may have been off when it was written.`);
  const prefix = (await git(vaultPath, ["rev-parse", "--show-prefix"])).trim();
  return { commit, content: await git(vaultPath, ["show", `${commit}^:${prefix}${path}`]) };
}

export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
