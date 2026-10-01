import { describe, expect, it } from "vitest";
import { connectSnippet, isClient } from "./connect.js";

const stdio = "C:\\Life-Kernel\\apps\\mcp\\dist\\stdio.js";
const config = "C:\\Life-Kernel\\lifekernel.config.json";

describe("connect snippets", () => {
  it("emits valid JSON for Claude Desktop with escaped Windows paths", () => {
    const parsed = JSON.parse(connectSnippet("claude-desktop", stdio, config).content);
    expect(parsed.mcpServers.lifekernel).toEqual({ command: "node", args: [stdio], env: { LIFEKERNEL_CONFIG: config } });
  });

  it("emits a claude mcp add command", () => {
    expect(connectSnippet("claude-code", stdio, config).content).toBe(`claude mcp add lifekernel --env LIFEKERNEL_CONFIG="${config}" -- node "${stdio}"`);
  });

  it("uses TOML literal strings so backslashes are not escapes", () => {
    const toml = connectSnippet("codex", stdio, config).content;
    expect(toml).toContain(`args = ['${stdio}']`);
    expect(toml).toContain(`LIFEKERNEL_CONFIG = '${config}'`);
  });

  it("nests the server under each editor's own key", () => {
    for (const client of ["cursor", "windsurf", "gemini-cli"] as const) {
      expect(JSON.parse(connectSnippet(client, stdio, config).content).mcpServers.lifekernel).toEqual({ command: "node", args: [stdio], env: { LIFEKERNEL_CONFIG: config } });
    }
    expect(JSON.parse(connectSnippet("vscode", stdio, config).content).servers.lifekernel).toEqual({ type: "stdio", command: "node", args: [stdio], env: { LIFEKERNEL_CONFIG: config } });
  });

  it("recognizes only supported clients", () => {
    expect(isClient("codex")).toBe(true);
    expect(isClient("cursor")).toBe(true);
    expect(isClient("notepad")).toBe(false);
  });
});
