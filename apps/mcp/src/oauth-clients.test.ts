import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifeKernelOAuth } from "./oauth.js";

const callback = "https://claude.ai/api/mcp/auth_callback";

async function provider(maxClients: number) {
  const stateDir = await mkdtemp(join(tmpdir(), "lifekernel-clients-"));
  let clock = Date.parse("2026-10-01T12:00:00Z");
  const oauth = new LifeKernelOAuth({ publicUrl: new URL("http://localhost"), ownerSecret: "owner-secret-with-plenty-of-length", stateDir, maxClients, now: () => clock });
  const register = (name: string) => oauth.clientsStore.registerClient!({ redirect_uris: [callback], client_name: name, token_endpoint_auth_method: "none" } as never);
  return { oauth, stateDir, register, advance: (seconds: number) => { clock += seconds * 1000; } };
}

describe("client registration limit", () => {
  it("refuses new registrations instead of evicting a client that is still fresh", async () => {
    const { register } = await provider(2);
    await register("one");
    await register("two");
    await expect(register("three")).rejects.toThrow(/Too many registered clients/);
  });

  it("drops the oldest never-connected client once it is past the grace period", async () => {
    const { oauth, register, advance } = await provider(2);
    const first = await register("junk-1");
    await register("junk-2");
    advance(2 * 60 * 60);
    const fresh = await register("fresh");
    expect(await oauth.clientsStore.getClient(first.client_id)).toBeUndefined();
    expect(await oauth.clientsStore.getClient(fresh.client_id)).toBeDefined();
  });

  it("never evicts a client that completed a sign-in, even when it is the oldest", async () => {
    const { oauth, register, advance, stateDir } = await provider(2);
    const connected = await register("connected");
    const junk = await register("junk");
    // Complete a sign-in for the first client: a persisted refresh token is what marks it as connected.
    await (oauth as unknown as { issue(clientId: string, scopes: string[], resource: string): Promise<unknown> }).issue(connected.client_id, ["lifekernel:read"], "http://localhost/mcp");
    advance(2 * 60 * 60);
    await register("fresh");
    expect(await oauth.clientsStore.getClient(connected.client_id)).toBeDefined();
    expect(await oauth.clientsStore.getClient(junk.client_id)).toBeUndefined();
    expect(await readFile(join(stateDir, "audit.jsonl"), "utf8")).not.toContain("oauth_registration_refused");
  });

  it("audits a refused registration", async () => {
    const { register, stateDir } = await provider(1);
    await register("one");
    await expect(register("two")).rejects.toThrow();
    expect(await readFile(join(stateDir, "audit.jsonl"), "utf8")).toContain("oauth_registration_refused");
  });
});
