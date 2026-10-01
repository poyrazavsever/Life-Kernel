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

## Session context

`context_bundle` (MCP) or `POST /v1/context` returns the minimum context for a session in one call: the vault's bundle notes, today's daily note, and the most recent earlier daily notes, within `maxChars` (default 24000). Notes that are missing, `restricted` (unless requested), `none`, or over budget are listed under `skipped` with a reason. Each note carries the hash of the full note, so a truncated read can still be followed by a safe write.

The default bundle is `AGENTS.md`, `system/AI Context.md`, `system/Method.md`, `state/Current State.md`, `profile/Profile.md`, `schedule/Capacity.md`, and `schedule/Near-Term Plan.md`. A vault can override it with a `bundle` array of relative paths in its config entry.

`note_backlinks` (MCP) or `POST /v1/backlinks` lists AI-readable notes that link to a note by path or by name, with line excerpts.
