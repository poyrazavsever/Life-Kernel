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
- `POST /v1/validate`

Search and read omit `restricted` notes unless the caller sets `includeRestricted: true`; `ai_access: none` is never returned. The write body follows the same request schema used by MCP. Reusing a `requestId` with identical content returns the prior result; reusing it with different content fails. Appends require the SHA-256 observed when the note was read.

## Write operations

- `create`: new note under the route folder, named `<sourceDate>-<title slug>.md`.
- `append`: add text to the end of an existing note in the route folder.
- `update_section`: replace the body under one heading (`section`) in an existing note in the route folder. Nested headings belong to their parent section. Fenced code and frontmatter are never treated as headings. An unknown or duplicated heading fails instead of guessing.

Both modifying operations require `targetPath` and the `expectedSha256` from the last read, and they refresh `updated` in frontmatter when the note has that field.
