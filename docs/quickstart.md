# Quick start

Life Kernel gives the AI you already talk to a memory it can read and update: a folder of Markdown notes that you own. Set it up once, then spend about fifteen minutes each evening telling your AI how the day went; it records the day, plans tomorrow, and keeps a trail of what you decided.

Pick the path that fits how you use AI:

| You use | Path | Time |
| --- | --- | --- |
| Claude Desktop, Claude Code, Codex, Cursor, VS Code, Windsurf, or Gemini CLI | [A. On your computer](#a-on-your-computer) | about 5 minutes |
| Claude.ai or ChatGPT in the browser or phone app | [B. Reachable from the internet](#b-reachable-from-the-internet) | about 30 minutes, once |

Both use the same vault, the same skills, and the same first conversation.

## A. On your computer

You need [Node.js](https://nodejs.org) 22 or newer and Git.

```bash
git clone https://github.com/poyrazavsever/Life-Kernel.git
cd Life-Kernel
npm install
npm run build
npm run cli -- init ./vaults/personal
npm run cli -- doctor
```

`init` copies a starter vault into `vaults/personal` and writes `lifekernel.config.json` next to it, with your computer's time zone. `doctor` should report `"ok": true`.

Open `vaults/personal` as a vault in [Obsidian](https://obsidian.md) if you use it. Any Markdown editor works too.

Connect your AI client. This prints the exact setting to paste, with the right paths for your machine:

```bash
npm run cli -- connect claude-desktop    # or claude-code, codex, cursor, vscode, windsurf, gemini-cli
```

Follow the printed instruction (Claude Desktop: merge the block into its config file and restart the app; Claude Code: run the printed `claude mcp add` command). Then go to [your first conversation](#your-first-conversation).

## B. Reachable from the internet

Claude.ai and ChatGPT connect over HTTPS from the cloud, so Life Kernel has to be reachable at a public address and sign you in with OAuth. You need a domain name. The easiest way to publish a service from your own computer is a [Cloudflare Tunnel](remote.md#run-it-from-your-own-computer-with-a-cloudflare-tunnel); a small server works too. Either way, the computer or server has to be on while your AI uses it.

You need Docker, Node.js 22 or newer, and Git.

1. **Get the code and a vault.**

   ```bash
   git clone https://github.com/poyrazavsever/Life-Kernel.git
   cd Life-Kernel
   npm install && npm run build
   npm run cli -- init ./vaults/personal
   cp lifekernel.config.docker.example.json lifekernel.config.json
   ```

   The Docker config maps the vault to `/vaults/personal` inside the container and keeps state in a volume.

2. **Choose an owner secret.** It is the password you type once when you connect an AI app, so only you can authorize it. Make it long and random:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

3. **Create `.env`** next to `compose.yaml`, with your address and that secret. Keep this file out of Git; it is already ignored.

   ```bash
   LIFEKERNEL_PUBLIC_URL=https://lifekernel.example.com
   LIFEKERNEL_OWNER_SECRET=<the secret from step 2>
   ```

4. **Start the server** from the published image:

   ```bash
   docker compose pull
   docker compose up -d
   ```

   To build from the checkout instead, use `docker compose up -d --build`. On Linux, also put your user and group IDs in `.env` (`LIFEKERNEL_UID`, `LIFEKERNEL_GID`, from `id -u` and `id -g`) so the notes it writes stay editable by you.

5. **Publish it** at the address from step 3 with a [Cloudflare Tunnel](remote.md#run-it-from-your-own-computer-with-a-cloudflare-tunnel) or a reverse proxy that terminates HTTPS and forwards to `127.0.0.1:8787`. Do not put Cloudflare Access in front of it; Life Kernel's own sign-in is the gate.

6. **Check it** before you connect anything:

   ```bash
   npm run cli -- check-remote https://lifekernel.example.com
   ```

   Every line should say `PASS`. A failing line says what to fix.

7. **Connect your AI app.**
   - **Claude.ai:** Settings, Connectors, add a custom connector, and enter `https://lifekernel.example.com/mcp`.
   - **ChatGPT:** in Settings, find Apps (Connectors) and turn on developer mode, then create a connector with the same URL and OAuth sign-in. ChatGPT has not been verified end to end yet; if it cannot connect, [open an issue](https://github.com/poyrazavsever/Life-Kernel/issues) with the error it shows.

   Menu names in both products change from time to time; look for "custom connector" or "developer mode".

   Your browser then opens Life Kernel's consent page. Check the app's name, choose what it may do (leave "Allow writing notes" on so it can keep your vault up to date, and pick which vaults it sees), type your **owner secret**, and approve.

Now you are ready for [your first conversation](#your-first-conversation).

## Your first conversation

Say:

> Set up my Life Kernel vault.

The assistant loads the onboarding skill and interviews you. Expect fifteen to thirty minutes:

- It asks two or three related questions at a time and accepts messy, voice-note style answers in any order, in your own language.
- It covers your roles and responsibilities, short, medium, and long-term goals, current projects, when you are available, what a good and a bad day look like, and what you want kept private.
- It offers planning methods (themed days, time blocks, a daily top three, or a minimal rhythm) and lets you pick or mix. Nothing is imposed.
- Anything you do not know or do not want to say stays blank. It does not guess dates or numbers.
- At the end it shows you the whole map once, asks for one approval, and then writes everything.

## Every day after that

- **Evening:** say "Let's do the circle." In about fifteen minutes it records how the day went, ticks what you finished, and sets tomorrow's focus.
- **Morning (optional):** say "Plan my day."
- **Once a week:** say "Let's do the weekly review." It checks the week against the capacity you actually showed and sets next week's commitments.
- **Anytime:** ask "When did I decide X, and why?" or "Where does the Pebble project stand?" Answers cite the note they came from.

Life Kernel never starts a conversation on its own. If you want a nudge at the time you chose, turn on [reminders](notifications.md).

## If something does not work

- **The connector cannot connect.** Run `check-remote` and fix the first failing line. The most common causes are an address that is not HTTPS, a tunnel that is not running, and `LIFEKERNEL_PUBLIC_URL` that differs from the address you typed.
- **The consent page rejects the secret.** Five wrong attempts from one address lock it for 15 minutes. Copy the secret from `.env` without extra spaces.
- **The assistant does not follow the setup flow.** Add one line to its instructions (a Claude project's instructions, `CLAUDE.md`, or `AGENTS.md`): "For planning, daily circles, and reviews, use the lifekernel server and call `skill_get` first."
- **Nothing is written.** A route can need your approval; the assistant shows a preview and asks. Say yes, or tell it in advance what it may do without asking (it records that in your Method note).
- **See what was written.** Every write is recorded in `audit.jsonl` in the state folder (`.lifekernel-data/`, or the state volume under Docker). If the vault is a Git repository and its config sets `"history": "git"`, each write is also a commit, and `npm run cli -- undo <requestId>` reverses one.

## Where to go next

[Connecting clients](clients.md) · [Remote mode](remote.md) · [Reminders and capture](notifications.md) · [Self-hosting](self-hosting.md) · [Security model](security-model.md) · [Personal, startup, and work vaults in one hub](hub.md)
