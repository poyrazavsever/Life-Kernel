import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "./sessions.js";

function session(clientId = "c") {
  const state = { closed: false };
  const transport = { close: async () => { state.closed = true; } } as unknown as StreamableHTTPServerTransport;
  return { state, value: { transport, clientId } };
}

describe("SessionRegistry", () => {
  it("closes a session that has been idle too long and forgets it", () => {
    let clock = 0;
    const registry = new SessionRegistry({ idleMs: 1000, now: () => clock });
    const a = session();
    registry.add("a", a.value);
    clock = 500;
    expect(registry.get("a")).toBeDefined();
    clock = 1400;
    expect(registry.get("a")).toBeDefined(); // used at 500, so still within the idle window
    clock = 3000;
    expect(registry.get("a")).toBeUndefined();
    expect(a.state.closed).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("closes the least recently used session when the limit is reached", () => {
    let clock = 0;
    const registry = new SessionRegistry({ max: 2, now: () => clock });
    const [a, b, c] = [session(), session(), session()];
    registry.add("a", a.value);
    clock = 10; registry.add("b", b.value);
    clock = 20; registry.get("a"); // a is now newer than b
    clock = 30; registry.add("c", c.value);
    expect(registry.get("b")).toBeUndefined();
    expect(b.state.closed).toBe(true);
    expect(registry.get("a")).toBeDefined();
    expect(registry.get("c")).toBeDefined();
    expect(registry.size).toBe(2);
  });

  it("removes a session whose transport closed on its own", () => {
    const registry = new SessionRegistry();
    registry.add("a", session().value);
    registry.remove("a");
    expect(registry.get("a")).toBeUndefined();
  });
});
