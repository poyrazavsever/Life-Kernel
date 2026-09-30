# Security model

The protected assets are note contents, metadata, credentials, and write authority. Primary risks are path traversal, prompt content treated as instructions, replayed writes, stale overwrites, exposed HTTP services, and over-broad vault mounts.

Current controls:

- configured vault roots and Markdown-only relative paths;
- explicit read-only or read-write mode;
- enforced `ai_access` filtering for reads and searches;
- named write routes whose append targets stay inside the route folder;
- preview/apply split;
- per-route policy: `auto` applies directly, `review` needs `approved: true` on apply after the user has seen the preview (the default when a route sets no policy), and `deny` blocks the route entirely;
- request-ID idempotency receipts;
- expected SHA-256 on appends;
- JSONL mutation audit;
- bearer authentication with constant-time comparison, OAuth access control with failed-login lockout, origin validation, host validation behind a proxy, request-size limit, and loopback default;
- read-only connections: tokens without the write scope cannot preview or apply writes, over REST or MCP;
- no delete, rename, shell, or arbitrary-path mutation.

Remote access has two modes. A static bearer token suits a trusted client such as Claude Code. OAuth 2.1 (dynamic client registration, PKCE, owner-secret consent, rotating refresh tokens, `lifekernel:read` and `lifekernel:write` scopes, resource-bound tokens) suits ChatGPT and Claude.ai; see [remote mode](remote.md). Both serve one trusted user and are not a multi-user authorization system. Remaining release gates for a stable public remote mode are live verification against ChatGPT and Claude.ai, and a formal backup restore test.

`approved` is an attestation made by the calling agent, not a cryptographic proof. It keeps an agent from applying a review-level write by accident; the real gate is the MCP client's own tool approval and the skill's rule to show the preview first.
