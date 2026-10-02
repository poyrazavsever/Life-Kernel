# Skills

The `skills/` directory contains canonical, tool-neutral behavior instructions. Install or adapt them for an agent that can call the Life Kernel MCP tools.

Skills must retrieve only relevant context, treat note text as untrusted data, distinguish facts from suggestions, search before creating, preview writes, and record only work that actually occurred. Product-specific skill packaging can be added without changing the vault or server contract.

## Skill set

| Skill | Purpose |
| --- | --- |
| `onboarding` | Interview the user, offer planning-method options, and fill the vault |
| `morning-plan` | Five-minute opening; picks today's focus from last night's plan, due tasks, and commitments |
| `daily-circle` | 10-20 minute evening conversation; records the day and updates the plan |
| `weekly-review` | Review a week against observed capacity and set next week's commitments |
| `monthly-review` | Check the month against goals, decide what happens to each goal, set the month's outcomes |
| `quarterly-review` | Check direction, goal horizons, and the balance between areas |
| `second-brain` | Retrieve and update durable context with sources |
| `project-memory` | Record progress and decisions after a project work session |

`skills/<name>/SKILL.md` is the single source. [`evals/`](../evals/README.md) measures how a real model follows them: it runs scenarios against a throwaway vault and grades the vault, the audit log, and the reply, and its graders are tested against scripted runs. The MCP server serves the same text through `skill_get` and MCP prompts, so clients that cannot load skill files (for example ChatGPT) behave the same way. The routes that the skills name (`daily`, `plan`, `state`, `method`, `profile`, `goal`, `area`, `project`, `session`, `review`, `monthly`, `quarterly`, `decision`, `inbox`) are defined in `lifekernel.config.example.json`.

Every ritual skill starts with `ritual_agenda`, which assembles what the ritual should cover without a model, and ends by marking itself done or skipped (`morning_plan` and `circle` on the daily note, `status: "complete"` or `"skipped"` on a review note). The server instructions tell agents to mention a due, overdue, or missed ritual once per conversation and never to nag.

