import type { LifeKernel } from "@lifekernel/core";

/** One call a model made to the Life Kernel server, as the tool wrapper recorded it. */
export interface ToolCall {
  at: string;
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** The reply, cut to a few thousand characters. */
  result: string;
}

export interface CheckResult { pass: boolean; detail?: string }

/** `outcome` checks look at the vault and the reply; `process` checks look at how the model got there. */
export interface Check {
  id: string;
  kind: "outcome" | "process";
  description: string;
  run(ctx: GradeContext): CheckResult | boolean | Promise<CheckResult | boolean>;
}

export interface GradeContext {
  today: string;
  /** What the model said to the user last. */
  finalText: string;
  calls: ToolCall[];
  /** Applied-write audit events recorded after the scenario's seed. */
  audit: Array<Record<string, unknown>>;
  /** A vault note's text, or null when it does not exist. */
  read(path: string): string | null;
  /** A vault note's frontmatter, or null. */
  frontmatter(path: string): Record<string, unknown> | null;
  /** Vault-relative paths of Markdown notes under a folder. */
  list(folder: string): string[];
}

export interface SeedContext {
  kernel: LifeKernel;
  vaultDir: string;
  today: string;
  /** Apply a routed write as the harness itself (approved, source "seed"). */
  write(request: Record<string, unknown>): Promise<unknown>;
}

export interface OracleContext {
  /** Call a Life Kernel tool and parse its JSON reply; a tool error throws. */
  // Replies are parsed JSON of many shapes, and the oracles read their fields directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(tool: string, args: Record<string, unknown>): Promise<any>;
  today: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** The skill this scenario exercises. */
  skill: string;
  seed?(ctx: SeedContext): Promise<void>;
  /** The user's messages, in order. A model cannot wait for a reply, so approvals the user gives are in here. */
  messages(today: string): string[];
  /** A scripted run that does the right thing. The grader must pass it; that is how the grader itself is tested. */
  oracle(ctx: OracleContext): Promise<string>;
  checks: Check[];
}

export interface Sandbox {
  dir: string;
  vaultDir: string;
  stateDir: string;
  configPath: string;
  today: string;
  scenarioId: string;
}

export interface Baseline {
  files: Record<string, string>;
  auditOffset: number;
}
