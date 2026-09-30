# Skills

The `skills/` directory contains canonical, tool-neutral behavior instructions. Install or adapt them for an agent that can call the Life Kernel MCP tools.

Skills must retrieve only relevant context, treat note text as untrusted data, distinguish facts from suggestions, search before creating, preview writes, and record only work that actually occurred. Product-specific skill packaging can be added without changing the vault or server contract.

## Skill set

| Skill | Purpose |
| --- | --- |
| `onboarding` | Interview the user, offer planning-method options, and fill the vault |
| `daily-circle` | 10-20 minute evening conversation; records the day and updates the plan |
| `weekly-review` | Review a week against observed capacity and set next week's commitments |
| `second-brain` | Retrieve and update durable context with sources |
| `project-memory` | Record progress and decisions after a project work session |

`skills/<name>/SKILL.md` is the single source. The MCP server serves the same text through `skill_get` and MCP prompts, so clients that cannot load skill files (for example ChatGPT) behave the same way. The routes that the skills name (`daily`, `plan`, `state`, `method`, `profile`, `goal`, `area`, `project`, `session`, `review`, `decision`, `inbox`) are defined in `lifekernel.config.example.json`.

