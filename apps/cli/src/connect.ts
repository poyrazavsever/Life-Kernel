export const CLIENTS = ["claude-desktop", "claude-code", "codex"] as const;
export type Client = (typeof CLIENTS)[number];

export function isClient(value: string | undefined): value is Client {
  return CLIENTS.includes(value as Client);
}

/** Build the copy-paste setup for a local stdio connection. Paths must be absolute. */
export function connectSnippet(client: Client, stdioPath: string, configPath: string): { file: string; content: string } {
  if (client === "claude-desktop") {
    return {
      file: "claude_desktop_config.json (merge into the existing mcpServers object)",
      content: JSON.stringify({ mcpServers: { lifekernel: { command: "node", args: [stdioPath], env: { LIFEKERNEL_CONFIG: configPath } } } }, null, 2)
    };
  }
  if (client === "claude-code") {
    return {
      file: "run in a terminal",
      content: `claude mcp add lifekernel --env LIFEKERNEL_CONFIG="${configPath}" -- node "${stdioPath}"`
    };
  }
  return {
    file: "~/.codex/config.toml",
    content: `[mcp_servers.lifekernel]\ncommand = "node"\nargs = ['${stdioPath}']\nenv = { LIFEKERNEL_CONFIG = '${configPath}' }`
  };
}
