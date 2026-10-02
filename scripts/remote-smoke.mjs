#!/usr/bin/env node
// Smoke test for a deployed Life Kernel, with credentials. `lifekernel check-remote` covers what a client does
// before anyone signs in; this covers what happens after, through whatever sits in front of the server
// (a reverse proxy or Cloudflare): a real MCP client over HTTPS, a long-lived stream, and the token-gated paths.
//
//   LIFEKERNEL_API_TOKEN=... [LIFEKERNEL_CAPTURE_TOKEN=...] [LIFEKERNEL_CALENDAR_TOKEN=...] \
//     node scripts/remote-smoke.mjs https://lifekernel.example.com [--idle-seconds 130] [--capture]
//
// Tokens are read from the environment and never printed. The capture check writes one labelled inbox item,
// so it only runs with --capture, and should be pointed at a test vault.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const base = args.find((arg) => /^https?:\/\//.test(arg));
if (!base) {
  process.stderr.write("Usage: remote-smoke.mjs <https://host> [--idle-seconds N] [--capture]\n");
  process.exit(2);
}
const flag = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const idleSeconds = Number(flag("--idle-seconds", "130"));
const token = process.env.LIFEKERNEL_API_TOKEN;
if (!token) { process.stderr.write("Set LIFEKERNEL_API_TOKEN.\n"); process.exit(2); }

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`); };
const timed = async (work) => { const start = performance.now(); const value = await work(); return { value, ms: Math.round(performance.now() - start) }; };
const attempt = async (name, work) => { try { const { pass, detail } = await work(); record(name, pass, detail); } catch (error) { record(name, false, error instanceof Error ? error.message : String(error)); } };
const auth = { authorization: `Bearer ${token}` };

// 1. A real MCP client over HTTPS.
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } });
const client = new Client({ name: "remote-smoke", version: "0.0.0" });
let tools = [];
await attempt("MCP client initializes over HTTPS and receives the server instructions", async () => {
  const { ms } = await timed(() => client.connect(transport));
  const instructions = client.getInstructions() ?? "";
  return { pass: instructions.includes("skill_get"), detail: `${ms} ms, ${instructions.length} characters of instructions` };
});
await attempt("tools/list returns the tool set", async () => {
  tools = (await client.listTools()).tools.map((tool) => tool.name);
  return { pass: ["skill_get", "context_bundle", "write_apply", "vault_list"].every((name) => tools.includes(name)), detail: `${tools.length} tools` };
});
await attempt("prompts/list carries the skills", async () => {
  const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
  return { pass: prompts.includes("daily_circle") && prompts.includes("onboarding"), detail: prompts.join(", ") };
});
let vaultId;
await attempt("vault_list and skill_get answer, with their latency", async () => {
  const vaults = await timed(() => client.callTool({ name: "vault_list", arguments: {} }));
  const list = JSON.parse(vaults.value.content[0].text);
  vaultId = list.find((vault) => vault.kind === "personal")?.id ?? list[0]?.id;
  const skill = await timed(() => client.callTool({ name: "skill_get", arguments: { name: "daily-circle" } }));
  const text = skill.value.content[0].text;
  return { pass: Boolean(vaultId) && /Daily circle/.test(text), detail: `vault_list ${vaults.ms} ms, skill_get ${skill.ms} ms (${text.length} characters)` };
});
await attempt("context_bundle on a vault returns its notes", async () => {
  const { value, ms } = await timed(() => client.callTool({ name: "context_bundle", arguments: { vaultId } }));
  const bundle = JSON.parse(value.content[0].text);
  return { pass: Array.isArray(bundle.notes) && bundle.notes.length > 0, detail: `${bundle.notes.length} notes in ${ms} ms` };
});

// 2. A long-lived stream. Proxies cut idle connections (Cloudflare's default is about 100 seconds), and the
// protocol's standalone event stream is exactly that: a GET that stays open. The SDK client above already holds
// one stream, and a server allows only one per session, so this check runs its own raw session. What matters is
// that the session survives and a client can carry on, not that the stream never closes.
await attempt(`the standalone event stream is refused cleanly (405) or holds, and the session survives ${idleSeconds} idle seconds`, async () => {
  const headers = { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = (body, extra = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "remote-smoke-stream", version: "0.0.0" } } });
  const sessionId = init.headers.get("mcp-session-id");
  await init.text();
  if (!sessionId) return { pass: false, detail: `no session ID (HTTP ${init.status})` };
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sessionId }).then((response) => response.text());

  const controller = new AbortController();
  const start = performance.now();
  let status = 0;
  let closedAfter = null;
  const stream = fetch(`${base}/mcp`, { headers: { ...auth, accept: "text/event-stream", "mcp-session-id": sessionId }, signal: controller.signal })
    .then(async (response) => {
      status = response.status;
      if (!response.ok || !response.body) return `answered HTTP ${response.status}`;
      const reader = response.body.getReader();
      for (;;) { const { done } = await reader.read(); if (done) { closedAfter = Math.round((performance.now() - start) / 1000); return "closed by the server or the proxy"; } }
    })
    .catch((error) => (error?.name === "AbortError" ? "still open when the wait ended" : `error: ${error?.message ?? error}`));
  await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000));
  controller.abort();
  const streamState = await stream;
  const after = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sessionId });
  const body = await after.text();
  const answered = after.status === 200 && body.includes("skill_get");
  await fetch(`${base}/mcp`, { method: "DELETE", headers: { ...auth, "mcp-session-id": sessionId } }).catch(() => undefined);
  // 405 is the right answer from a server that has nothing to push; 200 must then hold up, and 524 means a proxy cut it.
  return { pass: (status === 405 || status === 200) && answered, detail: `stream ${streamState}${closedAfter !== null ? ` after ${closedAfter} s` : ""}; tools/list afterwards: HTTP ${after.status}${answered ? "" : " without the tools"}` };
});
await client.close().catch(() => undefined);

// 3. The authentication boundary through the proxy.
await attempt("a wrong bearer token is refused with 401", async () => {
  const response = await fetch(`${base}/v1/vaults`, { headers: { authorization: "Bearer not-a-real-token-not-a-real-token-1234" } });
  return { pass: response.status === 401, detail: `HTTP ${response.status}` };
});
await attempt("a browser Origin that is not allowed is refused", async () => {
  const response = await fetch(`${base}/v1/vaults`, { headers: { ...auth, origin: "https://evil.example" } });
  return { pass: response.status === 403, detail: `HTTP ${response.status}` };
});

// 4. The calendar feed, which calendar apps fetch with the token in the URL.
const calendarToken = process.env.LIFEKERNEL_CALENDAR_TOKEN;
if (calendarToken) {
  await attempt("the ritual calendar feed serves iCalendar, and refuses a wrong token", async () => {
    const good = await fetch(`${base}/v1/rituals.ics?token=${encodeURIComponent(calendarToken)}`);
    const bad = await fetch(`${base}/v1/rituals.ics?token=wrong-wrong-wrong-wrong-wrong-wrong`);
    const body = await good.text();
    return { pass: good.status === 200 && body.startsWith("BEGIN:VCALENDAR") && bad.status === 401, detail: `good HTTP ${good.status}, wrong token HTTP ${bad.status}, ${(good.headers.get("content-type") ?? "").split(";")[0]}` };
  });
}

// 5. The capture token: one inbox item, and nothing else.
const captureToken = process.env.LIFEKERNEL_CAPTURE_TOKEN;
if (captureToken && args.includes("--capture")) {
  await attempt("the capture token adds one inbox item and cannot read anything", async () => {
    const post = await fetch(`${base}/v1/capture`, { method: "POST", headers: { authorization: `Bearer ${captureToken}`, "content-type": "application/json" }, body: JSON.stringify({ text: `Remote smoke test ${new Date().toISOString()}`, source: "remote-smoke" }) });
    const body = await post.json().catch(() => ({}));
    const read = await fetch(`${base}/v1/vaults`, { headers: { authorization: `Bearer ${captureToken}` } });
    return { pass: post.status === 200 && typeof body.path === "string" && read.status === 403, detail: `capture HTTP ${post.status} (${body.path ?? "no path"}), read HTTP ${read.status}` };
  });
}

const failed = results.filter((result) => !result.pass).length;
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
