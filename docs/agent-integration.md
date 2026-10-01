# Agent integration

## MCP over stdio

Build the repository and configure your MCP client to execute:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/Life-Kernel/apps/mcp/dist/stdio.js"],
  "env": { "LIFEKERNEL_CONFIG": "/absolute/path/to/lifekernel.config.json" }
}
```

## Remote MCP

Point a Streamable HTTP compatible client at `https://memory.example.com/mcp` and send `Authorization: Bearer <token>`. The reverse proxy must terminate TLS. Browser clients also need their exact origin in `LIFEKERNEL_ALLOWED_ORIGINS`.

## REST

Authenticated endpoints:

- `GET /v1/vaults`
- `POST /v1/search`
- `POST /v1/read`
- `POST /v1/writes/preview`
- `POST /v1/writes/apply`
- `POST /v1/daily`
- `POST /v1/period`
- `POST /v1/notes`
- `POST /v1/tasks`
- `POST /v1/rituals/status`
- `POST /v1/rituals/agenda`
- `POST /v1/context`
- `POST /v1/backlinks`
- `POST /v1/validate`

Search, read, listing, and tasks omit `restricted` notes unless the caller sets `includeRestricted: true`; `ai_access: none` is never returned. An `ai_access` value Life Kernel does not recognize counts as `restricted`. Search, listing, and tasks skip the vault's `ignore` folders (default `_templates`). The write body follows the same request schema used by MCP. Reusing a `requestId` with identical content returns the prior result; reusing it with different content fails. Appends require the SHA-256 observed when the note was read.

## Write operations

- `create`: new note under the route folder, named `<sourceDate>-<title slug>.md`, or `<period key>.md` on a periodic route. Needs `title` and `body`; may pass `fields`.
- `append`: add text to the end of an existing note in the route folder.
- `update_section`: replace the body under one heading (`section`) in an existing note in the route folder. Nested headings belong to their parent section. Fenced code and frontmatter are never treated as headings. An unknown or duplicated heading fails instead of guessing.
- `set_frontmatter`: set or remove (`null`) frontmatter keys in an existing note in the route folder, keeping comments, key order, and the body. Takes `fields`, not `body`.

`fields` (on `create` and `set_frontmatter`) may only name keys listed in the route's `fields` in the config, which `vault_list` reports. Values are single-line strings up to 500 characters, numbers, booleans, `null`, or lists of up to 50 strings or numbers. `id`, `type`, `created`, `updated`, `source`, `source_date`, `privacy`, and `ai_access` are protected: no route may list them.

The modifying operations require `targetPath` and the `expectedSha256` from the last read, and they refresh `updated` in frontmatter when the note has that field.

## Daily notes

A route whose `type` is `daily` always creates `<folder>/<sourceDate>.md`, so a date can have only one note regardless of title. Call `daily_get` (MCP) or `POST /v1/daily` first: it returns the note with its hash when it exists, so the agent updates it with `update_section` or `append`, and otherwise reports `exists: false` so the agent creates it. The date defaults to today in the configured `timezone`.

## Periodic notes

A route with `period` (`day`, `week`, `month`, or `quarter`) keeps one note per period, named by its key: `2026-10-01`, `2026-W40` (ISO week, Monday to Sunday), `2026-10`, or `2026-Q4`. Routes of type `daily` default to `day`. `create` derives the key from `sourceDate`, so a second note for the same period fails. `period_get` (MCP) or `POST /v1/period` takes `route` or `period` and an optional `date`, and returns the note with its hash, or `exists: false`, along with the period's `key`, `start`, and `end`.

## Listing and tasks

`note_list` (MCP) or `POST /v1/notes` lists notes by `type`, `status`, `area`, `folder`, `updatedBefore`, or `updatedAfter`, returning each note's title, frontmatter, and hash.

`tasks_open` (MCP) or `POST /v1/tasks` collects open (`- [ ]`) and in-progress (`- [/]`) checklist items written in Obsidian Tasks format: due `📅`, scheduled `⏳`, start `🛫`, priority `🔺⏫🔼🔽⏬`, recurrence `🔁`. Results are sorted by due date, then priority, and carry the note path, line, and hash. `dueBy` keeps tasks due on or before a date; `includeUndated: false` drops tasks without a due date.

## Rituals

`ritual_status` (MCP) or `POST /v1/rituals/status` reports each ritual (`morning-plan`, `daily-circle`, `weekly-review`, `monthly-review`, `quarterly-review`) as `not-scheduled`, `upcoming`, `due`, `overdue`, `done`, or `skipped`, with `dueAt` in the configured zone, `lastDone`, the daily `streak`, and `missed` days or periods. Days before the vault's first daily note never count as missed.

- The schedule is the method note's frontmatter (`system/Method.md`, or the vault's `methodNote`); see [vault specification](vault-spec.md#rhythm). A malformed value is reported in that ritual's `error` instead of failing the call.
- A daily ritual is complete when today's daily note has `morning_plan` or `circle` set to `done` or `skipped`. It is `due` for two hours after its time, then `overdue`.
- A review is complete when its period note has `status: complete` or `skipped`. It is `due` on its day and `overdue` after it until the period ends.
- A daily note the agent may not read counts as not done; its fields are never returned.

`ritual_agenda` (MCP) or `POST /v1/rituals/agenda` takes `ritual` and an optional `date` and returns what the ritual should cover, each item with its source note:

| Ritual | Agenda |
| --- | --- |
| `morning-plan` | yesterday's focus and open loops, the plan's focus for today, overdue and due tasks, today's fixed commitments from Availability |
| `daily-circle` | today's "Plan for today", overdue and due tasks, the plan's "This week", and `catchUp` when yesterday has no circle |
| `weekly-review` | the week's days with energy, focus, and circle fields and their totals; completed and overdue tasks; active projects untouched all week; the week's decisions; last week's commitments; stated and observed capacity |
| `monthly-review` | totals for the month, active goals with the number of linked active projects, and the month's weekly reviews |
| `quarterly-review` | totals for the quarter, goals, the quarter's monthly reviews, and active areas |

## Session context

`context_bundle` (MCP) or `POST /v1/context` returns the minimum context for a session in one call: the vault's bundle notes, today's daily note, and the most recent earlier daily notes, within `maxChars` (default 24000). Notes that are missing, `restricted` (unless requested), `none`, or over budget are listed under `skipped` with a reason. Each note carries the hash of the full note, so a truncated read can still be followed by a safe write. When the bundle is for today, it also carries `rituals`, the same report `ritual_status` returns.

The default bundle is `AGENTS.md`, `system/AI Context.md`, `system/Method.md`, `state/Current State.md`, `profile/Profile.md`, `schedule/Capacity.md`, and `schedule/Near-Term Plan.md`. A vault can override it with a `bundle` array of relative paths in its config entry.

`note_backlinks` (MCP) or `POST /v1/backlinks` lists AI-readable notes that link to a note by path or by name, with line excerpts.
