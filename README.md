# Life Kernel

**Your life and project context, owned by you and usable by any AI agent.**

Life Kernel is a self-hosted context layer built on ordinary Markdown folders. It gives AI agents a small, auditable interface for finding notes, reading source-backed context, and recording completed work without giving them unrestricted filesystem access.

It combines four pieces:

- a generic Obsidian-compatible starter vault;
- a safe write protocol with routes, request IDs, hashes, and an audit log;
- local CLI plus MCP over stdio or Streamable HTTP;
- reusable agent skills for onboarding, daily reflection, weekly review, project memory, and second-brain work.

## Status

Life Kernel is an early single-user developer preview. Local stdio is the recommended mode. Remote HTTP is intended for a private, TLS-protected deployment and requires a bearer token.

## Quick start

Requirements: Node.js 22+ and npm.

```bash
git clone https://github.com/poyrazavsever/Life-Kernel.git
cd Life-Kernel
npm install
npm run build
cp lifekernel.config.example.json lifekernel.config.json
npm run cli -- init ./vaults/personal
npm run cli -- doctor
```

Start a local MCP server:

```bash
LIFEKERNEL_CONFIG=./lifekernel.config.json npm run dev:stdio
```

Start the authenticated HTTP server:

```bash
LIFEKERNEL_API_TOKEN='use-a-long-random-token' npm run dev:http
```

The server exposes `/mcp` plus a small REST surface under `/v1`. See [agent integration](docs/agent-integration.md) and [self-hosting](docs/self-hosting.md).

## What agents can do

- list configured vaults;
- search Markdown with file, line, and SHA-256 provenance;
- read one safe relative Markdown path while enforcing `ai_access`;
- preview a routed create or append;
- apply the exact request idempotently;
- validate required frontmatter and inspect recent audit events.

There is no arbitrary shell access, delete, move, or unrestricted path write in v0.1.

## Repository map

```text
apps/cli                 local setup and maintenance commands
apps/mcp                 stdio MCP, HTTP MCP, and REST API
packages/core            vault, search, write, policy, and audit core
skills/                  reusable behavior instructions for agents
templates/starter-vault  generic Obsidian-compatible starting point
docs/                    public architecture and operations guides
```

## Principles

1. Markdown remains the source of truth.
2. The user owns storage and chooses every mounted vault.
3. Search results carry their source and content hash.
4. Writes are routed, previewable, idempotent, conflict-aware, and audited.
5. Skills decide how to work; MCP supplies constrained capabilities.

## License

MIT. See [LICENSE](LICENSE).
