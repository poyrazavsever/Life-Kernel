# One hub for your life, startup, and work

One Life Kernel server can hold several vaults: a personal vault for your plans and rituals, a startup vault for the company's shared memory, and a work vault for your job. Every AI client connects to the same server, and each one sees only the vaults you allow.

## Create the vaults

```bash
npm run cli -- init ./vaults/personal
npm run cli -- init ./vaults/startup --template startup
npm run cli -- init ./vaults/work --template work --id acme
```

`init` copies the template and adds the vault to `lifekernel.config.json` with its routes. `--id` names the vault (default: the template name). An existing vault with the same ID or path is left alone.

| Template | What it holds |
| --- | --- |
| `personal` | Profile, goals, areas, projects, schedule, daily notes, and weekly to quarterly reviews |
| `startup` | Vision, OKRs, customer segments and insights, product, projects, decisions, meetings, weekly metrics, investors, and weekly reviews |
| `work` | Role, stakeholders by role, projects, one-on-ones, decisions, and weekly reviews |

The startup and work templates record people by role or segment, never names or contact details.

## Send outcomes to your personal vault

Detail stays where the work happened. When work in the startup or work vault changes your plans, the agent writes a short outcome to the personal vault on route `outcome`: at most 600 characters, with a link to the detailed record such as `startup:sessions/2026-10-01-pricing.md`. The route refuses anything longer, anything unlinked, and later edits. Your weekly review lists the week's outcomes.

## Give each agent only what it needs

**Local clients** (stdio): add `--vaults` when you print the setup.

```bash
npm run cli -- connect cursor --vaults startup:write,personal:read
```

The client then sees the startup vault and can write to it, can read the personal vault, and does not know the work vault exists. `startup` alone means `startup:write`.

**Remote agents** (HTTP): give each agent its own token.

```bash
npm run cli -- token create coder --vaults startup:write
npm run cli -- token create reader --vaults personal:read,startup:read --read-only
npm run cli -- token list
npm run cli -- token revoke coder
```

The token is printed once; only its hash is stored. Writes by that agent appear in the audit log as `token:<name>`.

**ChatGPT and Claude.ai** (OAuth): the consent page lists every vault with **full access**, **read only**, or **no access**. Leaving every vault at full access also covers vaults you add later.

## Undo a write

Put a vault in a git repository and set `"history": "git"` on it in the config:

```bash
git -C ./vaults/startup init
git -C ./vaults/startup add .
git -C ./vaults/startup commit -m "Start"
```

Every applied write then becomes a commit that names the request and the client, never the note text. To reverse one:

```bash
npm run cli -- undo <requestId>          # report what would be restored
npm run cli -- undo <requestId> --apply  # restore it as a new commit
```

Undo refuses when the note changed after that write, because it would discard the later edits, and it never undoes a create, because Life Kernel never deletes notes. Find request IDs in `audit_recent` or the audit log in the state directory.
