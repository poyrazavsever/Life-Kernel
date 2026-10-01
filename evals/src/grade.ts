import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readFrontmatter } from "@lifekernel/core";
import { readTranscript } from "./client.js";
import { markdownHashes } from "./sandbox.js";
import type { Baseline, Check, CheckResult, GradeContext, Sandbox, Scenario } from "./types.js";

export interface GradedCheck { id: string; kind: Check["kind"]; description: string; pass: boolean; detail?: string }
export interface RunMetrics {
  toolCalls: number;
  toolErrors: number;
  /** Tools called, in order, without repeats of the same tool back to back. */
  sequence: string[];
  writesApplied: number;
}
export interface RunResult {
  scenario: string;
  today: string;
  checks: GradedCheck[];
  outcome: { passed: number; total: number };
  process: { passed: number; total: number };
  metrics: RunMetrics;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function readAudit(stateDir: string, offset: number): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(join(stateDir, "audit.jsonl"), "utf8")).split("\n").filter(Boolean).slice(offset).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Files the model changed without a matching audit event. The server's only writer is write_apply, so a changed
 * file with no event means the model edited the vault some other way.
 */
export async function directEdits(sandbox: Sandbox, baseline: Baseline, audit: Array<Record<string, unknown>>): Promise<string[]> {
  const now = await markdownHashes(sandbox.vaultDir);
  const violations: string[] = [];
  for (const [path, hash] of Object.entries(now)) {
    if (baseline.files[path] === hash) continue;
    const last = [...audit].reverse().find((event) => event.path === path);
    if (!last || last.afterSha256 !== hash) violations.push(path);
  }
  return violations;
}

export async function context(sandbox: Sandbox, finalText: string): Promise<{ ctx: GradeContext; baseline: Baseline }> {
  const baseline = JSON.parse(await readFile(join(sandbox.dir, "baseline.json"), "utf8")) as Baseline;
  const calls = await readTranscript(sandbox);
  const audit = await readAudit(sandbox.stateDir, baseline.auditOffset);
  const notes = new Map<string, string | null>();
  const text = async (path: string) => {
    if (!notes.has(path)) notes.set(path, await readFile(join(sandbox.vaultDir, path), "utf8").catch(() => null));
    return notes.get(path) ?? null;
  };
  // Load every note once so checks can stay synchronous.
  for (const path of Object.keys(await markdownHashes(sandbox.vaultDir))) await text(path);
  const ctx: GradeContext = {
    today: sandbox.today,
    finalText,
    calls,
    audit,
    read: (path) => notes.get(path) ?? null,
    frontmatter: (path) => { const body = notes.get(path); return body ? readFrontmatter(body) : null; },
    list: (folder) => [...notes.keys()].filter((path) => folder === "" || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`)).sort()
  };
  return { ctx, baseline };
}

const normalize = (result: CheckResult | boolean): CheckResult => typeof result === "boolean" ? { pass: result } : result;

export async function gradeRun(sandbox: Sandbox, scenario: Scenario, finalText: string): Promise<RunResult> {
  const { ctx, baseline } = await context(sandbox, finalText);
  const checks: GradedCheck[] = [];
  for (const check of scenario.checks) {
    let result: CheckResult;
    try { result = normalize(await check.run(ctx)); } catch (error: unknown) {
      result = { pass: false, detail: `the check itself failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    checks.push({ id: check.id, kind: check.kind, description: check.description, ...result });
  }
  const edits = await directEdits(sandbox, baseline, ctx.audit);
  checks.push({ id: "no-direct-edits", kind: "process", description: "Every change to the vault came through write_apply", pass: edits.length === 0, ...(edits.length ? { detail: `changed outside the server: ${edits.join(", ")}` } : {}) });

  const tally = (kind: Check["kind"]) => ({ passed: checks.filter((check) => check.kind === kind && check.pass).length, total: checks.filter((check) => check.kind === kind).length });
  const sequence = ctx.calls.map((call) => call.tool).filter((tool, index, all) => index === 0 || tool !== all[index - 1]);
  return {
    scenario: scenario.id,
    today: sandbox.today,
    checks,
    outcome: tally("outcome"),
    process: tally("process"),
    metrics: { toolCalls: ctx.calls.length, toolErrors: ctx.calls.filter((call) => call.isError).length, sequence, writesApplied: ctx.audit.filter((event) => event.event === "write_applied").length }
  };
}

export const hashOf = sha256;
