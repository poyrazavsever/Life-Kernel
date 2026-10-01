# Security policy

Life Kernel can expose private notes and, through write routes, change them. Treat every credential below and every mounted vault as sensitive.

## Supported mode

The beta supports one trusted user. Local stdio is the safest way to connect: no network service runs. Remote HTTP defaults to `127.0.0.1`, validates browser origins and the `Host` header behind a proxy, and must sit behind HTTPS. Do not publish port 8787 directly to the internet; use a reverse proxy with TLS, a private network or VPN, read-only mounts where possible, backups, and narrow vault routes.

## Credentials

| Credential | What it grants | Where it lives |
| --- | --- | --- |
| `LIFEKERNEL_API_TOKEN` | Read and write on every vault | Your `.env`, never in Git |
| `LIFEKERNEL_OWNER_SECRET` | Approving an OAuth sign-in for ChatGPT or Claude.ai | Your `.env` |
| Agent tokens (`lifekernel token create`) | The scopes and vaults you choose; only the hash is stored | The state directory |
| `LIFEKERNEL_CAPTURE_TOKEN` | Adding items to the inbox, nothing else | Your `.env` |
| `LIFEKERNEL_CALENDAR_TOKEN` | Ritual names and times; it travels in a URL, so rotate it if the URL leaks | Your `.env` |
| `LIFEKERNEL_ACTION_SECRET` | Signing snooze and skip links | Your `.env`, or a random file in the state directory |
| Telegram bot token, SMTP URL, ntfy topic and token, webhook secret | Sending reminders | Your `.env` |
| `ANTHROPIC_API_KEY` | Prepared briefs, if you enable them | Your `.env` |

Use long random values, keep one per purpose, and rotate any that may have leaked. The full list of controls is in the [security model](docs/security-model.md).

## Data that leaves your machine

Life Kernel sends nothing on its own. Your AI client sends whatever you discuss and whatever notes the agent fetches to that provider. Reminders can carry a line from your plan to ntfy, Telegram, or your mail server when a channel uses `agenda` content. Prepared briefs, off by default, send a ritual's agenda to the Claude API. See [what is sent where](docs/notifications.md#what-is-sent-where).

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories for this repository. Do not place secrets or real vault samples in an issue.
