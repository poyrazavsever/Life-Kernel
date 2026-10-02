import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connect } from "./client.js";
import { gradeRun } from "./grade.js";
import { createSandbox } from "./sandbox.js";
import { scenarios } from "./scenarios/index.js";
import type { Scenario } from "./types.js";

// The graders are the instrument, so they are tested first: a scripted run that does the right thing must pass
// every check, and a run that does nothing must not. Only then can a model's score mean anything.

async function run(scenario: Scenario, doTheWork: boolean) {
  const sandbox = await createSandbox(scenario, { baseDir: await mkdtemp(join(tmpdir(), "lifekernel-evals-")) });
  const connection = await connect(sandbox);
  let finalText = "";
  try {
    if (doTheWork) {
      finalText = await scenario.oracle({
        today: sandbox.today,
        call: async (tool, args) => {
          const { text, isError } = await connection.call(tool, args);
          if (isError) throw new Error(`${tool} failed: ${text}`);
          try { return JSON.parse(text); } catch { return text; } // skill_get returns Markdown, not JSON
        }
      });
    }
  } finally {
    await connection.close();
  }
  return gradeRun(sandbox, scenario, finalText);
}

describe.each(scenarios.map((scenario) => [scenario.id, scenario] as const))("scenario %s", (_id, scenario) => {
  it("is passed in full by a scripted run that follows the skill", async () => {
    const result = await run(scenario, true);
    const failed = result.checks.filter((check) => !check.pass).map((check) => `${check.id}${check.detail ? ` (${check.detail})` : ""}`);
    expect(failed).toEqual([]);
    expect(result.outcome.passed).toBe(result.outcome.total);
    expect(result.process.passed).toBe(result.process.total);
  }, 120_000);

  it("is not passed by a run that does nothing", async () => {
    const result = await run(scenario, false);
    const outcomeFailures = result.checks.filter((check) => check.kind === "outcome" && !check.pass);
    // A question or a hold-off can legitimately need no writes, but a do-nothing run must still miss something.
    expect(outcomeFailures.length + result.checks.filter((check) => check.kind === "process" && !check.pass).length).toBeGreaterThan(0);
    expect(result.metrics.toolCalls).toBe(0);
  }, 120_000);
});

describe("grading", () => {
  it("catches a model that edits the vault without going through the server", async () => {
    const scenario = scenarios.find((candidate) => candidate.id === "approval-discipline")!;
    const sandbox = await createSandbox(scenario, { baseDir: await mkdtemp(join(tmpdir(), "lifekernel-evals-")) });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(sandbox.vaultDir, "goals/2026-11-30-learn-rust-basics.md"), "---\nid: x\ntype: goal\nstatus: active\narea: life\nprivacy: personal\nai_access: context\n---\n\n# Learn Rust basics\n", "utf8");
    const result = await gradeRun(sandbox, scenario, "Done, I saved it.");
    expect(result.checks.find((check) => check.id === "no-direct-edits")).toMatchObject({ pass: false });
    expect(result.checks.find((check) => check.id === "no-goal-saved")).toMatchObject({ pass: false });
  }, 120_000);
});
