---
name: lifekernel-project-memory
description: Record durable project progress, decisions, verification, and open questions after an agent work session.
---

# Project memory

Use at the end of meaningful project work, or when the user asks to record what was done.

1. Read the project's context note and search for an existing session with the same external session or request ID, so you update instead of duplicating.
2. Record only work actually completed, sources consulted, verification that really ran (with results; never claim tests you did not run), decisions the user accepted, proposals still awaiting a decision, open questions, and one next action.
3. Keep code in the repository. Store a concise durable account in the vault on route `session`, linked from the canonical project note. Tasks stay in the project note, not in the session.
4. Follow the write protocol in the daily-circle skill. Use the external session or request ID as part of `requestId` so a retry is idempotent.
5. A project agent sends only a short, source-linked outcome to a personal vault; detailed history stays in the project vault.
