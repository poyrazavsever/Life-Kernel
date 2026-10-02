# Security model

The protected assets are note contents, metadata, credentials, and write authority. Primary risks are path traversal, prompt content treated as instructions, replayed writes, stale overwrites, exposed HTTP services, and over-broad vault mounts.

Current controls:

- configured vault roots and Markdown-only relative paths; symbolic links and Windows junctions below a vault root are rejected on direct note access (the root itself is owner-configured). The host filesystem remains trusted: this is not isolation against a local process racing to replace directories;
- explicit read-only or read-write mode;
- enforced `ai_access` filtering for reads and searches;
- named write routes whose append targets stay inside the route folder;
- frontmatter writes limited to each route's `fields` allowlist; identity, provenance, and access keys (`id`, `type`, `created`, `updated`, `source`, `source_date`, `privacy`, `ai_access`) are protected and a config that lists them fails to load, so no agent can widen a note's AI access;
- an `ai_access` value that is not `context`, `restricted`, or `none` counts as `restricted`, so a typo never widens access;
- preview/apply split;
- per-route policy: `auto` applies directly, `review` needs `approved: true` on apply after the user has seen the preview (the default when a route sets no policy), and `deny` blocks the route entirely;
- request-ID idempotency receipts, written as pending before the note changes and finalized only after audit and optional Git history. Recovery preserves the original writer and timestamp and recognizes an already appended audit event or history commit;
- expected SHA-256 on appends and section updates, checked while holding a per-vault lock file in the state directory, so two agents in separate processes cannot both pass the check and overwrite each other (a lock older than 30 seconds is treated as left by a crashed process and taken over);
- note replacements written to a temporary file and renamed into place. If Windows refuses the replacement, the operation fails without truncating the original; there is no in-place fallback. This protects replacement integrity, not power-loss durability of filesystem caches;
- JSONL mutation audit that names the writer: `client.id` is the authenticated client (OAuth client ID or `static-token`) and `client.name` is the name the client reported when it connected, which the client chooses and which is not verified;
- frontmatter, including `ai_access`, is read the same way with LF, CRLF, or a byte-order mark, so a note saved by a Windows editor cannot slip past the access filter;
- bearer authentication with constant-time comparison, OAuth access control with failed-login lockout, origin validation, host validation behind a proxy, request-size limit, and loopback default;
- read-only connections: tokens without the write scope cannot preview or apply writes, over REST or MCP;
- ritual status and agendas are built only from notes the agent may read; a daily note marked `none` counts as not done, and its fields are never returned;
- reminders: channel secrets (ntfy topic and token, webhook URL and secret) come only from environment variables; ntfy and webhook endpoints must be https (http only on localhost); messages carry no note text unless a channel opts into `agenda` content, which adds at most one 80-character line from readable notes; desktop notifications pass text only through environment variables, never through a shell or script; webhooks are signed over a timestamp and the body; the audit log records each reminder's ritual, channels, and outcome, never its text;
- capture: `LIFEKERNEL_CAPTURE_TOKEN` carries only the `lifekernel:capture` scope, which reaches `/v1/capture` and nothing else; captured text is stored as data under the inbox route and skills treat it as data, never instructions;
- reminder actions: snooze and skip links are HMAC-signed over the ritual, action, occurrence, expiry, and a random nonce; each works once (the nonce is recorded), expires after a day, and does nothing for a past occurrence; the key comes from `LIFEKERNEL_ACTION_SECRET` or a random file in the state directory;
- Telegram: only updates from `LIFEKERNEL_TELEGRAM_CHAT_ID` are acted on; others are ignored; the bot token is never written to errors or the audit log; captures from Telegram are idempotent by update ID;
- email: SMTP requires TLS (smtps, or STARTTLS on smtp) except on localhost, file and URL access in messages is disabled, and delivery errors report a code, never the SMTP URL;
- vault grants: a connection limited by `LIFEKERNEL_VAULTS`, a named agent token, or the OAuth consent page runs on a kernel view in which ungranted vaults do not exist and read-only grants cannot be written; grants name vaults that must exist, so a typo fails instead of granting nothing; tokens without vault grants keep access to every vault;
- named agent tokens are stored only as SHA-256 hashes in the state directory, compared in constant time, and revocable one by one; their writes appear in the audit log as `token:<name>`;
- rollup routes accept only short, linked outcomes (at most 600 characters, a link to the source, no later edits), so a project agent cannot copy detailed project history into the personal vault;
- git history: commits name the request, route, source, and client but never note text, and only the written path is committed; `undo` is an owner CLI action that refuses when the note changed after the write or when the write was a create, and is audited;
- insights are computed locally from notes the agent may read and report counts and dates, not note text, apart from the titles of tasks planned repeatedly;
- prepared briefs are off by default; when enabled, a ritual's agenda (from `context` notes only, hashes removed) is sent to the Claude API with the owner's credentials, framed as data the model must not take instructions from; failures fall back to the fixed reminder, briefs are never written to the vault, and the audit log records only whether one was written;
- the calendar feed uses its own token, which must differ from the API token and grants only ritual names and times; because calendar apps cannot send headers, it travels in the URL, so treat the feed URL as a secret and rotate the token if it leaks;
- no delete, rename, shell, or arbitrary-path mutation. `lifekernel migrate` edits templates and the vault marker outside any route, but only from the owner's CLI; it is not an agent tool, and it is audited.

Remote access has two modes. A static bearer token suits a trusted client such as Claude Code. OAuth 2.1 (dynamic client registration, PKCE, owner-secret consent, rotating refresh tokens, `lifekernel:read` and `lifekernel:write` scopes, resource-bound tokens) suits ChatGPT and Claude.ai; see [remote mode](remote.md). Both serve one trusted user and are not a multi-user authorization system. Remaining release gates for a stable public remote mode are live verification against ChatGPT and Claude.ai, and a formal backup restore test.

`approved` is an attestation made by the calling agent, not a cryptographic proof. It keeps an agent from applying a review-level write by accident; the real gate is the MCP client's own tool approval and the skill's rule to show the preview first.
