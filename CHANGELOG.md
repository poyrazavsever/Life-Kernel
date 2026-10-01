# Changelog

## Unreleased

Insights (roadmap phase 6).

- `insights_period`, `POST /v1/insights`, and `lifekernel insights`: energy and its weekday pattern, focus hours against stated capacity, morning plan and circle consistency, completed and overdue tasks, and open tasks planned on three or more days, with plain observations that cite their numbers and dates. Review agendas include them, and the review skills start from them.
- Prepared briefs, off by default: with `notifications.briefs.enabled`, reminders on agenda channels carry a short brief written by Claude from the ritual's agenda, using the owner's API credentials and server-side fallbacks. `lifekernel brief` previews one.

Central hub (roadmap phase 5).

- `lifekernel init --template personal|startup|work [--id]` creates startup and work vaults and adds them to an existing config with their routes.
- Rollup routes take short, linked outcomes from other vaults; the personal example config gains an `outcome` route, and the weekly review lists the week's outcomes.
- Vault grants: `LIFEKERNEL_VAULTS` for stdio clients (`lifekernel connect <client> --vaults`), named agent tokens (`lifekernel token create|list|revoke`), and per-vault choices on the OAuth consent page. Each connection runs on a kernel view without its ungranted vaults.
- `"history": "git"` commits every applied write in the vault's repository; `lifekernel undo <requestId> [--apply]` restores the previous content as a new commit.
- `lifekernel connect` supports Cursor, VS Code, Windsurf, and Gemini CLI.

Capture and replies (roadmap phase 4).

- Capture: `lifekernel capture`, `POST /v1/capture` (with full write access or the new capture-only `LIFEKERNEL_CAPTURE_TOKEN`), and Telegram messages append to today's inbox note. Redelivered requests are not written twice; concurrent captures are retried.
- The morning plan and daily circle list open inbox items; the circle offers to file each one and marks the inbox note processed.
- Snooze and skip buttons: signed, single-use, day-long links on ntfy reminders (`notifications.actionBaseUrl`), and callback buttons on Telegram.
- Telegram channel: reminders with Start, Snooze, and Skip; `/today`, `/status`, `/snooze`, `/skip`; only the owner's chat is answered. `lifekernel telegram setup` finds the chat ID.
- Email channel over smtps or STARTTLS (nodemailer 10).
- `lifekernel today` prints the focus, due and overdue tasks, inbox count, and rituals.
- The inbox route keeps one note per day; a daily-note lookup prefers the route typed `daily`.

- `lifekernel init` writes `lifekernel.config.json` for the new vault when none exists, with the computer's time zone. A missing config now produces instructions instead of a bare ENOENT.
- The CLI, the stdio server, and the HTTP server read a `.env` file beside the config without overriding variables already set, so scheduled reminder checks see the ntfy topic and other secrets.
- `vaults/` is ignored by Git, so a vault created inside the checkout is never committed.

Ritual reminders (roadmap phase 3).

- `lifekernel tick` sends one reminder when a ritual is due and at most one follow-up, respecting quiet hours, snoozes, and pauses; it is safe to run every few minutes and remembers what it sent.
- Channels: ntfy for phones, desktop notifications on Windows, macOS, and Linux, and HMAC-signed webhooks. Messages are minimal by default, in English or Turkish, with an optional link that opens your AI client on the ritual.
- `lifekernel schedule install` registers the check with Task Scheduler, launchd, or a systemd user timer; `LIFEKERNEL_SCHEDULER=on` runs it inside the HTTP server for Docker and remote mode.
- `snooze`, `skip` (recorded in the vault), `pause`, and `resume`; `notify test` checks a channel.
- The rhythm as an iCalendar feed: `lifekernel ics`, or `/v1/rituals.ics` with its own `LIFEKERNEL_CALENDAR_TOKEN`.
- Example configs include a disabled `notifications` section; see `docs/notifications.md`.

Ritual engine (roadmap phase 2).

- `ritual_status` tool and `POST /v1/rituals/status`: each ritual is not scheduled, upcoming, due, overdue, done, or skipped, with its due time, streak, last completion, and recently missed days. The schedule lives in the method note's frontmatter; days before the vault's first daily note are never counted as missed.
- `ritual_agenda` tool and `POST /v1/rituals/agenda`: what the morning plan, daily circle, and weekly, monthly, and quarterly reviews should cover, assembled from the vault with sources and without a model.
- `context_bundle` includes ritual status for today. Server instructions tell agents to mention a due or missed ritual once and never nag.
- New skills `morning-plan`, `monthly-review`, and `quarterly-review`. The daily circle offers a short catch-up for a missed day; reviews mark themselves complete or skipped. Onboarding records the rhythm.
- Starter vault: ritual schedule keys in `system/Method.md`, a "Plan for today" section in the daily template, monthly and quarterly review templates, and `monthly` and `quarterly` routes. `lifekernel migrate` adds these to older vaults. New CLI commands `rituals` and `agenda`.

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
