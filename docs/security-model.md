# Security model

The protected assets are note contents, metadata, credentials, and write authority. Primary risks are path traversal, prompt content treated as instructions, replayed writes, stale overwrites, exposed HTTP services, and over-broad vault mounts.

Current controls:

- configured vault roots and Markdown-only relative paths;
- explicit read-only or read-write mode;
- enforced `ai_access` filtering for reads and searches;
- named write routes whose append targets stay inside the route folder;
- preview/apply split;
- request-ID idempotency receipts;
- expected SHA-256 on appends;
- JSONL mutation audit;
- bearer authentication, constant-time token comparison, origin validation, request-size limit, and loopback default;
- no delete, rename, shell, or arbitrary-path mutation.

The developer preview uses a shared bearer token for one trusted user. It is not a multi-user authorization system. OAuth, revocable scopes, rate limits, and formal backup restore tests remain release gates for a stable public remote mode.
