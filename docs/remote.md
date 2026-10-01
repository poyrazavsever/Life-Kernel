# Remote mode for ChatGPT and Claude.ai

ChatGPT and Claude.ai connect to an MCP server over HTTPS and sign in with OAuth. Claude Desktop, Claude Code, and Codex do not need this; use [local stdio](clients.md).

Life Kernel includes a small single-user OAuth 2.1 authorization server. It supports dynamic client registration, PKCE (S256), short-lived access tokens, rotating refresh tokens, and an owner-secret consent page. It is not a multi-user system.

> [!NOTE]
> The OAuth flow is covered by automated tests that play the client role, including a real MCP client over HTTP. It has not been verified against live ChatGPT or Claude.ai accounts, and those products change their connector screens and requirements. If a connection fails, check the audit log and the server output first, and open an issue with the client's error.

## What you need

- A small server (1 GB is enough) and a domain name pointing at it.
- TLS. The server listens on plain HTTP and expects a reverse proxy to terminate HTTPS.
- Docker, or Node.js 22.

## Configure

1. Copy `lifekernel.config.docker.example.json` to `lifekernel.config.json`. It maps the vault to `/vaults/personal` and keeps state in `/state`.
2. Create `.env` next to `compose.yaml`:

   ```bash
   LIFEKERNEL_PUBLIC_URL=https://memory.example.com
   LIFEKERNEL_OWNER_SECRET=<a long random passphrase, at least 20 characters>
   # Optional static token for trusted clients such as Claude Code:
   LIFEKERNEL_API_TOKEN=<a long random token, at least 24 characters>
   ```

   `LIFEKERNEL_PUBLIC_URL` is the origin only (no path). Keep the secret and token out of Git.
3. Start the server, then put the proxy in front of it:

   ```bash
   docker compose up -d --build
   ```

   Use [deploy/Caddyfile.example](../deploy/Caddyfile.example) for Caddy, or any proxy that forwards to `127.0.0.1:8787` and passes the `Host` and `X-Forwarded-*` headers.
4. Check it from outside:

   ```bash
   curl https://memory.example.com/health
   curl https://memory.example.com/.well-known/oauth-protected-resource/mcp
   ```

## Connect

The MCP URL is `https://memory.example.com/mcp`.

- **Claude.ai:** add a custom connector with that URL. Claude registers itself and opens the Life Kernel consent page.
- **ChatGPT:** enable developer mode, create a connector with that URL, and choose OAuth. ChatGPT registers itself and opens the consent page.

On the consent page, check who is connecting and where the browser will return, type your owner secret, and choose whether to allow writing. Leave writing unchecked for a read-only connection. The client then appears to the server as a separate client with its own tokens.

After connecting, say "Set up my Life Kernel vault." The agent loads the onboarding skill through `skill_get`.

## Operate

- **Revoke one client:** disconnect the connector in the client. Its tokens stop working when they expire (one hour) and the refresh token is rotated away.
- **Revoke everything:** delete `oauth.json` from the state directory and restart; then rotate `LIFEKERNEL_OWNER_SECRET`.
- **Audit:** `audit.jsonl` records client registration, approvals, denials, failed sign-ins, and every applied write (path, hashes, and size, never note text). It never contains secrets or tokens.
- **Failed sign-ins:** five wrong owner secrets from one address lock the consent page for 15 minutes.
- **Back up** the vault and the state directory.
- **Reminders:** set `LIFEKERNEL_SCHEDULER=on` and an ntfy topic or webhook to send ritual reminders from the server, and `LIFEKERNEL_CALENDAR_TOKEN` for a calendar feed. See [ritual reminders](notifications.md).

## Security notes

- Serve only over HTTPS. The server refuses a non-HTTPS public URL except for localhost.
- Redirect URIs must be `https`, or `http` on localhost. The consent page shows the redirect host so you can spot an unexpected client.
- Anyone can register a client, but no client gets a token without the owner secret. Registration is capped at 100 clients. A client that never signed in can be dropped after an hour to make room; a client you connected is never dropped, and when nothing can be dropped the new registration is refused and audited. A flood of junk registrations therefore cannot disconnect ChatGPT or Claude.ai.
- MCP sessions close after 30 idle minutes, and at most 100 stay open (the least recently used closes first). A client whose session ended gets a 404 and initializes a new one without you doing anything.
- Tokens are bound to `https://<your host>/mcp`. Refresh tokens are stored only as hashes; access tokens live in memory, so a restart makes clients refresh.
- Connector clients share your vault's `ai_access` rules. Notes marked `none` are never returned; `restricted` notes require an explicit request.
- Content you discuss with ChatGPT or Claude goes to that provider. Life Kernel does not prevent that; it controls which notes the agent can fetch.
