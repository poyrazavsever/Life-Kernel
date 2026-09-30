# Architecture

Life Kernel separates behavior from access.

```text
AI client + skill
       |
       | MCP stdio / MCP HTTP / REST
       v
Life Kernel server
  policy -> search/read -> preview/apply -> audit
       |
       v
configured Markdown vaults
```

Skills decide when to ask, retrieve, summarize, or record. The server enforces vault roots, modes, routes, note-only paths, request idempotency, expected content hashes, and an audit trail.

The first release deliberately uses direct text search. Markdown stays portable and no database becomes the source of truth. A later index may improve retrieval without changing the storage contract.

Each configured vault has a stable ID, kind, root, access mode, and allowed routes. A project agent should keep detailed technical history in the project vault and send only a short, source-linked outcome to a personal vault.
