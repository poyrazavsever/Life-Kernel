# Changelog

## Unreleased (toward 0.1.0)

Remote mode for ChatGPT and Claude.ai.

- Single-user OAuth 2.1 authorization server: dynamic client registration, PKCE, owner-secret consent page, rotating refresh tokens, resource-bound tokens, read-only or read-write grants, failed-login lockout.
- `lifekernel:read` and `lifekernel:write` scopes enforced on REST and MCP write tools; MCP sessions are bound to the client that created them.
- Remote mode guide, Docker config with a writable state volume, Caddy example. The container image was built and exercised; live ChatGPT and Claude.ai verification is still open and gates 0.1.0.
- Fix: the audit log no longer copies note text.

## 0.1.0-alpha.0

Local-first alpha: Claude Desktop, Claude Code, and Codex over stdio MCP. Remote HTTP still uses a shared bearer token; ChatGPT and Claude.ai need the OAuth work planned for 0.1.0.

- Method-neutral English starter vault: profile, goals, areas, projects, schedule, decisions, current state, daily and weekly notes.
- Write routes with `auto`, `review`, and `deny` policies; `create`, `append`, and `update_section` operations.
- One daily note per date, `daily_get`, `context_bundle`, and `note_backlinks`.
- Skills (onboarding, daily circle, weekly review, second brain, project memory) served through MCP instructions, prompts, and `skill_get`.
- `lifekernel connect` for Claude Desktop, Claude Code, and Codex.
- Fixes: `requestId` is restricted to a safe character set (it was used as a receipt filename); dates use the configured time zone instead of UTC.
