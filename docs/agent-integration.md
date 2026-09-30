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

The write body follows the same request schema used by MCP. Reusing a `requestId` with identical content returns the prior result; reusing it with different content fails. Appends require the SHA-256 observed when the note was read.
