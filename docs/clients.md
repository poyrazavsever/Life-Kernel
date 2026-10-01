# Connecting agent clients

Life Kernel speaks MCP, so every client below talks to the same server and receives the same behavior: the server sends instructions at startup and serves each skill through the `skill_get` tool and MCP prompts. You do not install skill files in any client.

## Prerequisites

```bash
npm install && npm run build
npm run cli -- init ./vaults/personal   # also writes lifekernel.config.json if it is missing
npm run cli -- doctor
```

`lifekernel connect <client>` prints the setup with absolute paths filled in for this checkout:

```bash
npm run cli -- connect claude-desktop
npm run cli -- connect claude-code
npm run cli -- connect codex
npm run cli -- connect cursor   # also vscode, windsurf, gemini-cli
```

## Claude Desktop

Merge the printed `mcpServers` entry into `claude_desktop_config.json` (Settings, Developer, Edit Config), then restart Claude Desktop.

## Claude Code

Run the printed `claude mcp add ...` command once. Check it with `claude mcp list`.

## Codex

Append the printed block to `~/.codex/config.toml` and restart Codex.

## Cursor, VS Code, Windsurf, and Gemini CLI

`lifekernel connect cursor`, `vscode`, `windsurf`, or `gemini-cli` prints a JSON block and the file it belongs in. Merge it into that file's existing servers object and restart the editor or CLI. VS Code reads `servers` with `"type": "stdio"`; the others read `mcpServers`.

## First conversation

Say: "Set up my Life Kernel vault." The agent calls `skill_get` for `onboarding` and interviews you in your own language, including when you want each ritual. Each morning say: "Let's plan the day." Each evening say: "Let's do the circle." Once a week, after the circle, say: "Let's do the weekly review." Monthly and quarterly reviews work the same way. When a ritual is due, any connected agent mentions it once at the start of a conversation. To be reminded outside a conversation, set up [ritual reminders](notifications.md).

If a client does not pick the behavior up on its own, add one line to its instruction file (`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, or your Claude Desktop project instructions): "For planning, daily circles, and reviews, use the lifekernel MCP server and call `skill_get` first."

## Remote clients

ChatGPT and Claude.ai connect over HTTPS and cannot run a local process. They need the OAuth-enabled remote mode; see [remote mode](remote.md).
