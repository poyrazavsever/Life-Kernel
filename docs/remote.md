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

## Run it from your own computer with a Cloudflare Tunnel

You do not need a server to try remote mode. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) publishes a port on your computer under a hostname in a domain you manage on Cloudflare, with HTTPS, and without opening anything on your router. The computer has to be on while ChatGPT or Claude.ai use it.

1. Install `cloudflared` and sign in: `cloudflared tunnel login`.
2. Create the tunnel and its DNS record: `cloudflared tunnel create lifekernel`, then `cloudflared tunnel route dns lifekernel lifekernel.example.com`.
3. Point it at the server in `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: <the tunnel ID that create printed>
   credentials-file: <the path create printed>
   ingress:
     - hostname: lifekernel.example.com
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```
4. Start the server with `LIFEKERNEL_PUBLIC_URL=https://lifekernel.example.com` and `LIFEKERNEL_OWNER_SECRET` set (`npm run dev:http`), then run the tunnel with `cloudflared tunnel run lifekernel`.

Do not put Cloudflare Access in front of the hostname: ChatGPT and Claude.ai cannot sign in to it, and Life Kernel's own OAuth sign-in is the gate. Try it on a test vault first, not on the notes you care about.

## Check it before you connect

```bash
npm run cli -- check-remote https://lifekernel.example.com
```

It makes the requests ChatGPT and Claude.ai make before a user signs in: HTTPS, `/health`, the 401 that points to the resource metadata, the OAuth metadata (code with PKCE S256, refresh tokens, dynamic registration), a registration with each product's callback URL, and the consent page. It needs no credentials. Each run registers two throwaway clients, which expire on their own. A failing line says what to fix.

After the server is running with a token, `scripts/remote-smoke.mjs` checks what happens after sign-in, through whatever sits in front of it:

```bash
LIFEKERNEL_API_TOKEN=... node scripts/remote-smoke.mjs https://lifekernel.example.com
```

It connects a real MCP client over HTTPS, checks the instructions, tools, prompts, and latency, holds a session idle for about two minutes (proxies cut idle connections), and checks the wrong-token, wrong-origin, and calendar-feed paths. Add `LIFEKERNEL_CAPTURE_TOKEN` and `--capture` to also test the phone-capture path; it writes one labelled inbox item, so point it at a test vault. Tokens are read from the environment and never printed.

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
- **No standalone event stream.** `GET /mcp` answers 405, which the protocol allows for a server that never pushes unrequested messages. Life Kernel never does, and a held-open GET would be cut by a proxy after 100 seconds (Cloudflare's 524). Replies to `POST` requests still stream.
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
