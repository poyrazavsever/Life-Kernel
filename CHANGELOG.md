# Changelog

## Unreleased

Planning data (roadmap phase 1).

- `set_frontmatter` operation and `fields` on `create`, limited to each route's `fields` allowlist; protected keys can never be listed. Decisions can now be accepted, goals finished, and next actions set.
- Frontmatter is read and written with a YAML parser that keeps comments and key order. `ai_access` accepts trailing comments, and an unrecognized value counts as `restricted`.
- Periodic routes (`period: day | week | month | quarter`) keep one note per period, named `2026-10-01`, `2026-W40`, `2026-10`, or `2026-Q4`; new `period_get` tool and `POST /v1/period`.
- `note_list` tool and `POST /v1/notes` list notes by type, status, area, folder, or updated date.
- `tasks_open` tool and `POST /v1/tasks` collect open tasks in Obsidian Tasks format, sorted by due date and priority.
- `vault_search` matches every term in any order, ignores case and accents (so "istanbul" finds "İstanbul"), and filters by `type` and `status`.
- Search, listing, and tasks skip the vault's `ignore` folders (default `_templates`).
- `vault_list` reports each route's period and writable fields.
- Starter layout 3: daily template fields `energy`, `focus_hours`, `morning_plan`, `circle`, `circle_at`, and a tasks convention in the vault's `AGENTS.md`. `lifekernel migrate <vaultId> [--apply]` updates older vaults. New CLI commands `list` and `tasks`.
- Skills use the new tools: the daily circle records energy and marks itself done, the weekly review reads the week's fields and overdue tasks, and decisions are accepted with `set_frontmatter`.

## 0.1.0 (in progress)

Remote mode for ChatGPT and Claude.ai.

- Single-user OAuth 2.1 authorization server: dynamic client registration, PKCE, owner-secret consent page, rotating refresh tokens, resource-bound tokens, read-only or read-write grants, failed-login lockout.
- `lifekernel:read` and `lifekernel:write` scopes enforced on REST and MCP write tools; MCP sessions are bound to the client that created them.
- Remote mode guide, Docker config with a writable state volume, Caddy example. The container image was built and exercised; live ChatGPT and Claude.ai verification is still open and gates 0.1.0.
- Fix: the audit log no longer copies note text.

Hardening (roadmap phase 0).

- Writes to one vault are serialized across processes with a lock file, so concurrent agents get a hash conflict instead of a lost update.
- Receipts are written as pending before the note changes; a retry after a crash completes the write. Older receipts still replay.
- Modified notes are replaced atomically through a temporary file.
- Audit events for applied writes carry `client.id` (authenticated client) and `client.name` (reported by the client).
- Fix: `validate` and the `ai_access` filter read frontmatter with CRLF line endings or a BOM; on Windows checkouts `validate` reported every note as missing its frontmatter.
- Fix: `append` keeps the note's line endings.
- Fix: slugs transliterate `ı`, `ß`, `ø`, and similar letters instead of dropping them, and a title with no Latin letters gets a slug from its `requestId`, so preview and apply produce the same path.
- `.gitattributes` keeps text files LF in every checkout; CI runs on Linux, Windows, and macOS.
- The server and health endpoint read their version from `package.json`. `LifeKernel` accepts an injected clock for tests.

## 0.1.0-alpha.0

Local-first alpha: Claude Desktop, Claude Code, and Codex over stdio MCP. Remote HTTP still uses a shared bearer token; ChatGPT and Claude.ai need the OAuth work planned for 0.1.0.

- Method-neutral English starter vault: profile, goals, areas, projects, schedule, decisions, current state, daily and weekly notes.
- Write routes with `auto`, `review`, and `deny` policies; `create`, `append`, and `update_section` operations.
- One daily note per date, `daily_get`, `context_bundle`, and `note_backlinks`.
- Skills (onboarding, daily circle, weekly review, second brain, project memory) served through MCP instructions, prompts, and `skill_get`.
- `lifekernel connect` for Claude Desktop, Claude Code, and Codex.
- Fixes: `requestId` is restricted to a safe character set (it was used as a receipt filename); dates use the configured time zone instead of UTC.
