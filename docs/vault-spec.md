# Vault specification v1

Every managed note is UTF-8 Markdown with YAML frontmatter. Normal notes require:

- `id`: stable note identity;
- `type`: note class;
- `status`: lifecycle state;
- `area`: owning area;
- `privacy`: human privacy label;
- `ai_access`: `context`, `restricted`, or `none`;
- `created` and `updated` when the note is generated;
- `source` and `source_date` for agent-written facts.

The server never returns `ai_access: none` notes. `restricted` notes require an explicit `includeRestricted: true` request; ordinary search and read calls omit them. Privacy labels still do not encrypt files, so a deployment must enforce filesystem and network access separately.

Tasks live in one canonical project or area note. Session notes contain evidence and link to that task. Decisions retain rationale and status. Unknown facts remain blank.

## Starter layout (layout version 3)

The starter vault is an English, method-neutral scaffold. Folders exist for planning evidence, not for a prescribed method.

| Path | Purpose | Note `type` |
| --- | --- | --- |
| `profile/` | Who the user is and how agents should talk to them | `profile` |
| `goals/` | One note per goal; `horizon` is `short`, `medium`, or `long` | `goal` |
| `areas/` | Ongoing responsibilities | `area` |
| `projects/` | Bounded efforts; `due` and `next_action` are optional | `project` |
| `schedule/` | `Availability`, `Capacity`, and `Near-Term Plan` | `schedule`, `plan` |
| `system/Method.md` | The planning method the user chose during onboarding | `method` |
| `decisions/` | Decisions with `decided_on` and `supersedes`; `status` is `proposed` until the user accepts | `decision` |
| `daily/`, `reviews/` | One note per day and per week | `daily`, `weekly-review` |
| `state/Current State.md` | Dated snapshot of where things stand | `state` |
| `sessions/` | Evidence from agent work sessions | `session` |

Conventions: goals, decisions, and sessions are never deleted; their `status` changes. Tasks live in one project or area note. Unknown values stay blank. Agents follow `system/Method.md` rather than imposing a method, and converse in the user's language while keeping note headings in the template language.

## Vault kinds and templates

A vault's `kind` is `personal`, `startup`, `work`, `project`, or `research`. `lifekernel init --template personal|startup|work` creates one; the startup and work templates ship their routes in `.lifekernel/routes.json`. See [one hub for your life, startup, and work](hub.md).

A route with `"rollup": true` takes short outcomes from other vaults (at most 600 characters, with a `[[wikilink]]`, a URL, or a `vault:path.md` reference) and allows no appends or section edits. A vault with `"history": "git"` commits every applied write in its git repository.

## Planning fields and tasks (layout version 3)

Daily notes carry optional frontmatter that the daily circle fills only when the user states it: `energy` (1-5), `focus_hours`, `morning_plan` and `circle` (`done` or `skipped`), and `circle_at` (ISO 8601). Weekly reviews are named by ISO week (`reviews/2026-W40.md`).

Tasks are checklist items in their project or area note, in Obsidian Tasks format: `- [ ] Draft pricing page 📅 2026-10-04 ⏫`. `- [x]` is done, `- [-]` cancelled, `- [/]` in progress.

Agents change status, dates, and next actions with `set_frontmatter`, limited to the keys each route lists under `fields`. A vault made with an older layout is updated with `lifekernel migrate <vaultId>` (a report) and `lifekernel migrate <vaultId> --apply`.

## Rhythm

The method note (`system/Method.md`) holds the user's ritual schedule in frontmatter. Onboarding writes it with `set_frontmatter` on route `method`; a blank value turns a ritual off.

| Keys | Values |
| --- | --- |
| `morning_plan_time`, `daily_circle_time` | 24-hour `HH:MM` |
| `morning_plan_days`, `daily_circle_days` | blank or `daily` (every day), `weekdays`, `weekends`, `mon,wed`, `mon-fri` |
| `weekly_review_day`, `weekly_review_time` | a weekday (default `sun`), `HH:MM` |
| `monthly_review_day`, `monthly_review_time` | a day number (clamped to the month), `last` (default), `first-mon`, or `last-sun`; `HH:MM` |
| `quarterly_review_day`, `quarterly_review_time` | as monthly, applied to the quarter's last month |
| `quiet_hours` | `HH:MM-HH:MM`, for example `23:00-08:00` |

Daily notes record completion in `morning_plan` and `circle` (`done` or `skipped`). Weekly, monthly, and quarterly review notes (`reviews/2026-W40.md`, `reviews/2026-10.md`, `reviews/2026-Q4.md`) are complete when `status` is `complete`, or `skipped` with the reason in the note. The daily template has a "Plan for today" section for the morning plan.
