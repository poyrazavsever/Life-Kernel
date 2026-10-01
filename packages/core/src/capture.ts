import { createHash } from "node:crypto";
import type { LifeKernel, WriteContext } from "./index.js";
import { readFrontmatter } from "./frontmatter.js";
import { isoInZone } from "./time.js";

const MAX_CAPTURE = 2000;

export interface CaptureResult { path: string; line: string; duplicate: boolean }
export interface InboxNote { path: string; sha256: string; items: string[] }

/**
 * Drop a thought into the inbox without an AI client. On a route that keeps one note per day, the item is
 * appended to today's inbox note as `- HH:MM text (source)`; otherwise each capture becomes its own note.
 * Pass a stable `requestId` (for example a Telegram update ID) so a redelivered message is not written twice.
 */
export async function capture(kernel: LifeKernel, vaultId: string, text: string, options: { source: string; requestId?: string; at?: Date; route?: string; context?: WriteContext }): Promise<CaptureResult> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("Nothing to capture.");
  if (clean.length > MAX_CAPTURE) throw new Error(`Captures are limited to ${MAX_CAPTURE} characters.`);
  const source = options.source.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 40) || "capture";
  const routeName = options.route ?? "inbox";
  const at = options.at ?? new Date();
  const local = isoInZone(at, kernel.config.timezone);
  const date = local.slice(0, 10);
  const line = `- ${local.slice(11, 16)} ${clean} (${source})`;
  const requestId = options.requestId ?? `capture-${createHash("sha256").update(`${at.toISOString()}\n${clean}`).digest("hex").slice(0, 24)}`;
  const base = { vaultId, route: routeName, source, sourceDate: date };

  const route = kernel.config.vaults.find((vault) => vault.id === vaultId)?.routes[routeName];
  if (!route) throw new Error(`Vault ${vaultId} has no ${routeName} route for captures.`);
  if (!route.period) {
    const applied = await kernel.applyWrite({ ...base, requestId, operation: "create", title: clean.slice(0, 80), body: line }, options.context);
    return { path: applied.path, line, duplicate: applied.replayed };
  }

  // Captures from several devices can race for the same note; re-read and try again on a conflict.
  for (let attempt = 0; ; attempt += 1) {
    const note = await kernel.periodNote(vaultId, { route: routeName, date });
    try {
      if (!note.exists) {
        const applied = await kernel.applyWrite({ ...base, requestId, operation: "create", title: `Inbox ${date}`, body: line }, options.context);
        return { path: applied.path, line, duplicate: applied.replayed };
      }
      if (note.content.includes(line)) return { path: note.path, line, duplicate: true };
      const appended = await kernel.applyWrite({ ...base, requestId, operation: "append", targetPath: note.path, expectedSha256: note.sha256, body: line }, options.context);
      // New items reopen a note that was already triaged.
      const status = readFrontmatter(note.content)?.status;
      if (status !== route.status && (route.fields ?? []).includes("status")) {
        await kernel.applyWrite({ ...base, requestId: `${requestId}-reopen`, operation: "set_frontmatter", targetPath: note.path, expectedSha256: appended.afterSha256, fields: { status: route.status } }, options.context);
      }
      return { path: appended.path, line, duplicate: appended.replayed };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // The same requestId with different content means this capture was already written on an earlier delivery.
      if (/requestId was already used/.test(message)) return { path: note.path, line, duplicate: true };
      if (attempt < 3 && /changed after it was read|already exists/.test(message)) continue;
      throw error;
    }
  }
}

/** Inbox notes still waiting for triage (status equal to the route's starting status), with their items. */
export async function inboxItems(kernel: Pick<LifeKernel, "config" | "listNotes" | "readNote">, vaultId: string, routeName = "inbox"): Promise<InboxNote[]> {
  const route = kernel.config.vaults.find((vault) => vault.id === vaultId)?.routes[routeName];
  if (!route) return [];
  const notes: InboxNote[] = [];
  for (const listed of await kernel.listNotes(vaultId, { folder: route.folder, status: route.status, limit: 50 })) {
    const note = await kernel.readNote(vaultId, listed.path).catch(() => null);
    if (!note) continue;
    const items = note.content.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line)).map((line) => line.replace(/^\s*[-*]\s+/, "").trim());
    if (items.length > 0) notes.push({ path: note.path, sha256: note.sha256, items });
  }
  return notes;
}
