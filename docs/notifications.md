# Ritual reminders

Life Kernel can remind you when a ritual is due: the morning plan, the daily circle, and the weekly, monthly, and quarterly reviews. A reminder is one short message with a link that opens your AI client with the ritual's starting phrase. Each occurrence gets one reminder and at most one gentle follow-up. Nothing is sent during quiet hours, while a ritual is snoozed, or while reminders are paused.

Reminders need two things: the rhythm in your vault, and somewhere to deliver the message. If you have no `lifekernel.config.json` yet, run `npm run cli -- init ./vaults/personal` first; it creates the vault and the config.

## 1. Set the rhythm

Onboarding asks when you want each ritual and records it in the frontmatter of `system/Method.md`. You can also edit it in Obsidian:

```yaml
morning_plan_time: "08:30"
morning_plan_days: "weekdays"
daily_circle_time: "21:30"
weekly_review_day: "sun"
weekly_review_time: "20:00"
quiet_hours: "23:00-08:00"
```

See the [vault specification](vault-spec.md#rhythm) for every key. Check the result with:

```bash
npm run cli -- rituals personal
```

## 2. Choose where reminders go

Channels are listed under `notifications` in `lifekernel.config.json`. Secrets never go in the config file; it only names the environment variables that hold them.

```json
"notifications": {
  "enabled": true,
  "locale": "en",
  "followUpAfterMinutes": 90,
  "channels": [
    { "type": "ntfy", "content": "minimal", "openUrl": "https://claude.ai/new?q={prompt}" },
    { "type": "desktop" }
  ]
}
```

`locale` is `en` or `tr`. `openUrl` is optional; `{prompt}` becomes a phrase such as "Let's do the circle." Use the new-chat link of the client you prefer and check that it opens with the text filled in. `rituals` limits a channel to some rituals, for example `"rituals": ["weekly-review", "monthly-review"]`.

### Phone: ntfy (recommended)

[ntfy](https://ntfy.sh) is a free push-notification app. You do not create an account: you subscribe to a topic name, and anything published to that topic appears on your phone.

1. Install ntfy on your phone (Android or iOS).
2. Make up a long, unguessable topic name, for example by running `node -e "console.log('lk-' + crypto.randomUUID())"`. The topic works like a password: anyone who knows it can read and send messages on it.
3. In the app, tap **+** and subscribe to that topic.
4. Create a file named `.env` next to `lifekernel.config.json` with the topic:

   ```bash
   LIFEKERNEL_NTFY_TOPIC=lk-your-random-topic
   ```

   Every Life Kernel command and server reads this file, including the scheduled check, which does not see variables set in your terminal. A variable already set in the environment wins over the file. To use your own ntfy server, also set `LIFEKERNEL_NTFY_URL` (https), and `LIFEKERNEL_NTFY_TOKEN` if it requires an access token.
5. In `lifekernel.config.json`, set `"enabled": true` under `notifications`.
6. Send a test:

   ```bash
   npm run cli -- notify test
   ```

### Desktop

`{ "type": "desktop" }` shows a system notification on the computer that runs the check: a toast on Windows, Notification Center on macOS, and `notify-send` on Linux. It works only where you are logged in, so it suits local mode, not Docker.

### Webhook

`{ "type": "webhook" }` posts JSON to `LIFEKERNEL_WEBHOOK_URL` (https) for n8n, Home Assistant, Slack, or your own service. When `LIFEKERNEL_WEBHOOK_SECRET` is set, each request carries `x-lifekernel-timestamp` and `x-lifekernel-signature: sha256=<HMAC-SHA256 of "<timestamp>.<body>">`. Reject requests whose signature does not match or whose timestamp is old.

### Telegram

A Telegram bot sends reminders with **Start**, **Snooze 1h**, and **Skip** buttons, and it listens: anything you write to it goes to your inbox, and it answers `/today`, `/status`, `/snooze <ritual> [minutes]`, and `/skip <ritual> [reason]`. It only ever reads and answers your own chat.

1. In Telegram, open **@BotFather**, send `/newbot`, and follow the steps. Copy the token it gives you into `.env` as `LIFEKERNEL_TELEGRAM_TOKEN`. Treat it like a password.
2. Add `{ "type": "telegram" }` to `channels`.
3. Send any message to your new bot, then run `npm run cli -- telegram setup` and put your chat's `id` in `.env` as `LIFEKERNEL_TELEGRAM_CHAT_ID`.
4. Run `npm run cli -- notify test`.

Replies are read by every `tick`, so locally a button press takes effect at the next check (within five minutes). With `LIFEKERNEL_SCHEDULER=on`, the server listens continuously and replies take seconds.

### Email

`{ "type": "email", "rituals": ["weekly-review", "monthly-review", "quarterly-review"] }` suits the longer reviews. Set `LIFEKERNEL_SMTP_URL` (for example `smtps://user:password@mail.example.com`; plain `smtp://` must offer STARTTLS unless it is localhost), `LIFEKERNEL_EMAIL_FROM`, and `LIFEKERNEL_EMAIL_TO`. URL-encode special characters in the password.

### Buttons on ntfy

In remote mode, set `"actionBaseUrl": "https://<your host>"` under `notifications`. ntfy reminders then carry **Snooze 1h** and **Skip** buttons. Each button is a signed link that works once, expires after a day, and does nothing for an earlier day's reminder. The signing key is generated in the state directory, or set `LIFEKERNEL_ACTION_SECRET` (32+ characters); changing it invalidates every link already sent.

## 3. Run the check every few minutes

`lifekernel tick` checks the rituals once and sends what is due. It is safe to run as often as you like: it remembers what it sent in `nudges.json` in the state directory. Preview without sending:

```bash
npm run cli -- tick --dry-run
```

**Local mode.** Register the check with your operating system's scheduler (Task Scheduler on Windows, launchd on macOS, a systemd user timer on Linux):

```bash
npm run cli -- schedule install
```

`--every 10` changes the interval in minutes; `--dry-run` shows the files and commands without changing anything; `schedule status` and `schedule uninstall` do what they say. If your computer was asleep, the next check catches up. The latest result is in `last-tick.json` in the state directory (on Linux, in `journalctl --user -u lifekernel-tick`).

**Docker and remote mode.** Set `LIFEKERNEL_SCHEDULER=on` (and optionally `LIFEKERNEL_TICK_MINUTES`) and the HTTP server runs the check itself. Desktop notifications do not work in a container; use ntfy or a webhook.

## Snooze, skip, and pause

```bash
npm run cli -- snooze daily-circle 1h        # hold one ritual's reminders
npm run cli -- skip daily-circle travelling  # record a skip in the vault, with a reason
npm run cli -- pause 2026-10-12              # hold every reminder through a date
npm run cli -- resume
```

A skip is written to the daily or review note as evidence for the next review, and the ritual stops being due. It is not counted as a failure.

## Capture a thought

Anything you capture lands in today's inbox note (`inbox/2026-10-01.md`) as `- 21:40 text (source)`, and the next daily circle offers to file it.

- **CLI:** `npm run cli -- capture Call the accountant about Q4`
- **Telegram:** write to your bot.
- **Phone shortcut or automation (remote mode):** set `LIFEKERNEL_CAPTURE_TOKEN` (24+ characters, different from your other tokens) and send `POST https://<your host>/v1/capture` with `Authorization: Bearer <capture token>` and JSON `{ "text": "...", "source": "shortcut" }`. That token can add to the inbox and do nothing else. Pass a unique `requestId` to make retries safe.

`npm run cli -- today` prints the day at a glance: the focus, due and overdue tasks, the inbox count, and ritual states.

## Calendar

Your rhythm can also appear as recurring events in Google Calendar, Apple Calendar, or Outlook.

- **One-time import:** `npm run cli -- ics > rituals.ics`, then import the file.
- **Subscription (remote mode):** set `LIFEKERNEL_CALENDAR_TOKEN` to a random value of 24 or more characters that differs from your API token, and subscribe to `https://<your host>/v1/rituals.ics?token=<that value>`. The feed contains ritual names and times only, and its token cannot read or write notes.

## What is sent where

- With `content: "minimal"` (the default), a message contains the ritual's name and a fixed sentence. Nothing from your notes leaves the machine.
- With `content: "agenda"`, it adds counts (tasks due, days recorded, goals without a project) and one focus line from your plan, at most 80 characters. That text goes to the channel's provider, for example ntfy.sh. Use it only with a channel you trust, such as a self-hosted ntfy server.
- Notes marked `restricted` or `none` never contribute to any message.
- The audit log records each reminder's ritual, channels, and outcome, never its text.
