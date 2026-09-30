---
name: lifekernel-weekly-review
description: Review one week of evidence in a Life Kernel vault and adjust next week's commitments to real capacity.
---

# Weekly review

Run only when the user starts it, typically after a daily circle on their chosen review day (see `system/Method.md`). Converse in the user's language.

## Gather

1. `vault_list`, then `context_bundle` for the personal vault (raise `recentDaily` to 7).
2. Read the week's daily notes that the bundle did not include, the project and session notes they link to, and accepted decisions from the week. Use `vault_search` and `note_read`; read only what you need.
3. Read `schedule/Capacity.md` and `system/Method.md`.

## Think, then talk

Distinguish what the notes show from what you guess. Cover: outcomes completed, work that stalled and the reasons the user gave, energy and start patterns, unexpected work, open loops, and planned versus observed capacity. Report one or two patterns the evidence supports. Quote dates, not impressions. Ask the user to correct your reading before you write anything.

## Decide

Propose a small set of commitments for next week that fits *observed* capacity, not the stated one. Respect the method's rules and the protected buffer. Do not silently carry over unfinished work; choose again. The user decides; record what they accept as decisions and leave the rest as proposals.

## Write

Follow the write protocol in the daily-circle skill.

- Create the weekly note on route `review` using the weekly review template sections.
- Update `schedule/Capacity.md` "Observed capacity" (route `plan`), citing the review note.
- Update `schedule/Near-Term Plan.md` and `state/Current State.md`.
- Record accepted decisions on route `decision`; they need the user's yes and `approved: true`.
- Link project changes to the canonical project note instead of copying tasks.

Close with: the honest summary, the patterns, next week's commitments, and what you changed.
