import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentToken, findAgentToken, grantScopes, grantsFromScopes, listAgentTokens, parseVaultGrants, revokeAgentToken } from "./access.js";
import { LifeKernel, type LifeKernelConfig } from "./index.js";

async function twoVaults() {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-access-"));
  const note = (text: string) => `---\nid: x\ntype: note\nstatus: active\narea: a\nprivacy: personal\nai_access: context\n---\n\n# ${text}\n`;
  for (const id of ["personal", "startup"]) {
    await mkdir(join(root, id, "sessions"), { recursive: true });
    await writeFile(join(root, id, "secret.md"), note(`${id} needle`), "utf8");
  }
  const session = { folder: "sessions", type: "session", status: "active", area: "a", policy: "auto" as const };
  const config: LifeKernelConfig = {
    version: 1, stateDir: join(root, "state"), timezone: "UTC",
    vaults: ["personal", "startup"].map((id) => ({ id, kind: id === "personal" ? "personal" as const : "startup" as const, path: join(root, id), mode: "read-write" as const, routes: { session } }))
  };
  return { root, kernel: new LifeKernel(config) };
}

describe("vault grants", () => {
  it("parse grants, default to write, and refuse unknown vaults or levels", () => {
    expect(parseVaultGrants("startup:write, personal:read", ["personal", "startup"])).toEqual({ read: ["startup", "personal"], write: ["startup"] });
    expect(parseVaultGrants("startup", ["startup"])).toEqual({ read: ["startup"], write: ["startup"] });
    expect(() => parseVaultGrants("startp:read", ["startup"])).toThrow(/Unknown vault in grant: startp/);
    expect(() => parseVaultGrants("startup:admin", ["startup"])).toThrow(/:read or :write/);
    expect(() => parseVaultGrants("", ["startup"])).toThrow(/at least one vault/);
  });

  it("round-trip through scopes, and no vault scopes means every vault", () => {
    const grants = { read: ["startup", "personal"], write: ["startup"] };
    expect(grantScopes(grants)).toEqual(["vault:startup:read", "vault:personal:read", "vault:startup:write"]);
    expect(grantsFromScopes(["lifekernel:read", ...grantScopes(grants)])).toEqual(grants);
    expect(grantsFromScopes(["lifekernel:read", "lifekernel:write"])).toBeNull();
  });
});

describe("restricted kernel", () => {
  it("hides ungranted vaults everywhere and makes read grants read-only", async () => {
    const { kernel } = await twoVaults();
    const view = kernel.restrictTo({ read: ["startup", "personal"], write: ["startup"] });
    const coder = kernel.restrictTo({ read: ["startup"], write: ["startup"] });
    expect(coder.listVaults().map((vault) => vault.id)).toEqual(["startup"]);
    expect((await coder.search("needle")).map((hit) => hit.vaultId)).toEqual(["startup"]);
    await expect(coder.readNote("personal", "secret.md")).rejects.toThrow(/Unknown vault: personal/);
    const write = (vaultId: string) => ({ requestId: `grant-${vaultId}-01`, vaultId, operation: "create", route: "session", title: "S", body: "x", source: "t", sourceDate: "2026-10-01" });
    await expect(view.previewWrite(write("personal"))).rejects.toThrow(/personal is read-only/);
    await expect(view.applyWrite(write("startup"))).resolves.toMatchObject({ vaultId: "startup" });
    expect(kernel.listVaults().map((vault) => vault.mode)).toEqual(["read-write", "read-write"]);
  });
});

describe("agent tokens", () => {
  it("store only a hash, match the presented token, and can be revoked", async () => {
    const { root } = await twoVaults();
    const stateDir = join(root, "state");
    const created = await createAgentToken(stateDir, "coder", ["lifekernel:read", "vault:startup:read"]);
    expect(created.token).toMatch(/^lk_[A-Za-z0-9_-]{43}$/);
    expect(await readFile(join(stateDir, "tokens.json"), "utf8")).not.toContain(created.token);
    await expect(findAgentToken(stateDir, created.token)).resolves.toMatchObject({ name: "coder", scopes: ["lifekernel:read", "vault:startup:read"] });
    await expect(findAgentToken(stateDir, `${created.token}x`)).resolves.toBeNull();
    await expect(createAgentToken(stateDir, "coder", [])).rejects.toThrow(/exists/);
    await expect(createAgentToken(stateDir, "Bad Name", [])).rejects.toThrow(/lowercase/);
    expect((await listAgentTokens(stateDir)).map((token) => token.name)).toEqual(["coder"]);
    expect(await revokeAgentToken(stateDir, "coder")).toBe(true);
    await expect(findAgentToken(stateDir, created.token)).resolves.toBeNull();
    expect(await revokeAgentToken(stateDir, "coder")).toBe(false);
  });
});
