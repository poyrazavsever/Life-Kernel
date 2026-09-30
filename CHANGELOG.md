# Changelog

## 0.1.0-alpha.0

Local-first alpha: Claude Desktop, Claude Code, and Codex over stdio MCP. Remote HTTP still uses a shared bearer token; ChatGPT and Claude.ai need the OAuth work planned for 0.1.0.

- Method-neutral English starter vault: profile, goals, areas, projects, schedule, decisions, current state, daily and weekly notes.
- Write routes with `auto`, `review`, and `deny` policies; `create`, `append`, and `update_section` operations.
- One daily note per date, `daily_get`, `context_bundle`, and `note_backlinks`.
- Skills (onboarding, daily circle, weekly review, second brain, project memory) served through MCP instructions, prompts, and `skill_get`.
- `lifekernel connect` for Claude Desktop, Claude Code, and Codex.
- Fixes: `requestId` is restricted to a safe character set (it was used as a receipt filename); dates use the configured time zone instead of UTC.
