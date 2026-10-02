import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultDeps } from "./channels.js";
import { BriefsSchema, defaultCreateMessage, prepareBrief } from "./briefs.js";

const OPTIONAL = ["@anthropic-ai/sdk", "nodemailer"];

describe("optional dependencies", () => {
  it("are never imported statically, so a vault that does not use them does not load them", async () => {
    const dir = new URL("./", import.meta.url);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    for (const name of files) {
      const source = await readFile(new URL(name, dir), "utf8");
      for (const pkg of OPTIONAL) {
        const staticImport = new RegExp(`^import\\s+(?!type\\b)[^;]*from\\s+["']${pkg}["']`, "m");
        expect(staticImport.test(source), `${name} statically imports ${pkg}; use import("${pkg}") or import type`).toBe(false);
      }
    }
  });

  it("still load on demand: nodemailer for email, the Anthropic SDK for briefs", async () => {
    // Nothing listens on port 1, so reaching a connection error proves nodemailer was imported and ran.
    await expect(defaultDeps().sendMail("smtp://127.0.0.1:1", { from: "a@example.com", to: "b@example.com", subject: "s", text: "t" })).rejects.toMatchObject({ code: expect.stringMatching(/ECONNREFUSED|ESOCKET|ETIMEDOUT|ECONNECTION/) });
    const create = defaultCreateMessage(BriefsSchema.parse({ enabled: true, apiKeyEnv: "LK_TEST_KEY_NOT_SET" }), { LK_TEST_KEY_NOT_SET: "sk-test-not-real" });
    // The SDK constructs and fails at the network or auth layer, not with a missing-module error.
    const result = await prepareBrief(create, BriefsSchema.parse({ enabled: true }), "morning-plan", {}, "en");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toMatch(/Cannot find|ERR_MODULE_NOT_FOUND/);
  }, 30_000);
});

describe("brief error classification", () => {
  const config = BriefsSchema.parse({ enabled: true });
  const failWith = (error: unknown) => prepareBrief(async () => { throw error; }, config, "morning-plan", {}, "en");

  it("maps the HTTP status the SDK attaches to a plain message", async () => {
    expect(await failWith(Object.assign(new Error("x"), { status: 401 }))).toEqual({ ok: false, error: "The Claude API rejected the credentials." });
    expect(await failWith(Object.assign(new Error("x"), { status: 429 }))).toEqual({ ok: false, error: "The Claude API rate limit was reached." });
    expect(await failWith(Object.assign(new Error("secret body"), { status: 529 }))).toEqual({ ok: false, error: "The Claude API returned 529." });
    expect(await failWith(new Error("socket hang up"))).toEqual({ ok: false, error: "The Claude API could not be reached." });
    expect(await failWith(null)).toEqual({ ok: false, error: "The Claude API could not be reached." });
  });
});
