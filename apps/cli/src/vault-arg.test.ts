import { describe, expect, it } from "vitest";
import { splitVaultArg } from "./vault-arg.js";

const vaults = ["personal", "startup"];

describe("splitVaultArg", () => {
  it("uses a leading vault ID and keeps the remaining arguments", () => {
    expect(splitVaultArg(["startup", "weekly-review", "2026-10-01"], vaults, "personal")).toEqual({ vaultId: "startup", rest: ["weekly-review", "2026-10-01"] });
  });

  it("falls back to the default vault and keeps every argument", () => {
    expect(splitVaultArg(["weekly-review"], vaults, "personal")).toEqual({ vaultId: "personal", rest: ["weekly-review"] });
    expect(splitVaultArg([], vaults, "personal")).toEqual({ vaultId: "personal", rest: [] });
  });

  it("does not mistake a note path or ritual for a vault", () => {
    expect(splitVaultArg(["projects/startup.md"], vaults, "personal").vaultId).toBe("personal");
  });
});
