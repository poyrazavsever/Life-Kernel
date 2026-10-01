export const CLIENTS = ["claude-desktop", "claude-code", "codex", "cursor", "vscode", "windsurf", "gemini-cli"] as const;
export type Client = (typeof CLIENTS)[number];

export function isClient(value: string | undefined): value is Client {
  return CLIENTS.includes(value as Client);
}

/** Where each JSON client keeps its MCP servers, and the key it nests them under. */
const JSON_CLIENTS: Partial<Record<Client, { file: string; key: string; type?: boolean }>> = {
  "claude-desktop": { file: "claude_desktop_config.json (merge into the existing mcpServers object)", key: "mcpServers" },
  cursor: { file: "~/.cursor/mcp.json, or .cursor/mcp.json in a project (merge into mcpServers)", key: "mcpServers" },
  vscode: { file: ".vscode/mcp.json in a workspace, or MCP: Open User Configuration (merge into servers)", key: "servers", type: true },
  windsurf: { file: "~/.codeium/windsurf/mcp_config.json (merge into mcpServers)", key: "mcpServers" },
  "gemini-cli": { file: "~/.gemini/settings.json (merge into mcpServers)", key: "mcpServers" }
};

/** Build the copy-paste setup for a local stdio connection. Paths must be absolute. */
export function connectSnippet(client: Client, stdioPath: string, configPath: string, vaults?: string): { file: string; content: string } {
  const env: Record<string, string> = { LIFEKERNEL_CONFIG: configPath, ...(vaults ? { LIFEKERNEL_VAULTS: vaults } : {}) };
  const json = JSON_CLIENTS[client];
  if (json) {
    const server = { ...(json.type ? { type: "stdio" } : {}), command: "node", args: [stdioPath], env };
    return { file: json.file, content: JSON.stringify({ [json.key]: { lifekernel: server } }, null, 2) };
  }
  if (client === "claude-code") {
    return {
      file: "run in a terminal",
      content: `claude mcp add lifekernel ${Object.entries(env).map(([key, value]) => `--env ${key}="${value}"`).join(" ")} -- node "${stdioPath}"`
    };
  }
  return {
    file: "~/.codex/config.toml",
    content: `[mcp_servers.lifekernel]\ncommand = "node"\nargs = ['${stdioPath}']\nenv = { ${Object.entries(env).map(([key, value]) => `${key} = '${value}'`).join(", ")} }`
  };
}
