import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTasks, readSection, type Task } from "@lifekernel/core";
import type { GradeContext, OracleContext, SeedContext, ToolCall } from "../types.js";

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${String(++counter).padStart(5, "0")}`;

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// ---- seeding ----

/** Apply a write against a note's current hash, as the harness. */
export async function seedEdit(ctx: SeedContext, path: string, request: Record<string, unknown>): Promise<void> {
  const content = await readFile(join(ctx.vaultDir, path), "utf8");
  await ctx.write({ requestId: nextId("seed"), targetPath: path, expectedSha256: sha256(content), ...request });
}

/** The rhythm and method a user would have after onboarding. */
export async function seedRhythm(ctx: SeedContext): Promise<void> {
  await seedEdit(ctx, "system/Method.md", { operation: "update_section", route: "method", section: "Chosen approach", body: "Themed days: each weekday has one main theme." });
  await seedEdit(ctx, "system/Method.md", {
    operation: "set_frontmatter", route: "method",
    fields: { daily_circle_time: "21:30", daily_circle_days: "daily", weekly_review_day: "sun", weekly_review_time: "20:00", quiet_hours: "23:00-08:00" }
  });
  await seedEdit(ctx, "system/Method.md", { operation: "update_section", route: "method", section: "Plan-update rules", body: "- The agent may update the near-term plan and current state without asking.\n- It must ask before changing goals or the profile." });
}

// ---- grading helpers ----

export const section = (ctx: GradeContext, path: string, heading: string): string | null => {
  const note = ctx.read(path);
  return note === null ? null : readSection(note, heading);
};

export const tasksOf = (ctx: GradeContext, path: string): Task[] => {
  const note = ctx.read(path);
  return note === null ? [] : parseTasks(note);
};

/** Notes in a folder other than its index note. */
export const notesIn = (ctx: GradeContext, folder: string, index: string): string[] => ctx.list(folder).filter((path) => path !== `${folder}/${index}`);

export const callsTo = (calls: ToolCall[], tool: string) => calls.filter((call) => call.tool === tool);

export function firstWriteIndex(calls: ToolCall[]): number {
  const index = calls.findIndex((call) => call.tool === "write_apply" || call.tool === "write_preview");
  return index === -1 ? calls.length : index;
}

/** Whether the model loaded a skill (by name) before its first write. */
export function skillBeforeWrite(calls: ToolCall[], name: string): boolean {
  const first = firstWriteIndex(calls);
  return calls.slice(0, first).some((call) => call.tool === "skill_get" && call.args.name === name);
}

/** Whether any of the named tools ran before the first write. */
export function readBeforeWrite(calls: ToolCall[], tools: string[]): boolean {
  const first = firstWriteIndex(calls);
  return calls.slice(0, first).some((call) => tools.includes(call.tool));
}

export const fmString = (value: unknown): string => (value === null || value === undefined ? "" : String(value)).trim();

// ---- oracle helpers ----

export function oracleTools(ctx: OracleContext, source: string) {
  const base = { vaultId: "personal", source, sourceDate: ctx.today, title: "Edit" };
  const write = (request: Record<string, unknown>) => ctx.call("write_apply", { request: { requestId: nextId("oracle"), ...base, ...request } });
  /** Read a note for its hash, then apply a write against it. */
  const edit = async (path: string, request: Record<string, unknown>) => {
    const note = await ctx.call("note_read", { vaultId: "personal", path });
    return write({ targetPath: path, expectedSha256: note.sha256, ...request });
  };
  return { write, edit, requestId: nextId };
}

/** The `request` argument of each write_apply (or write_preview) call. */
export const writeRequestsOf = (calls: ToolCall[], tool: "write_apply" | "write_preview" = "write_apply"): Array<Record<string, unknown>> =>
  calls.filter((call) => call.tool === tool).map((call) => (call.args.request ?? {}) as Record<string, unknown>);
