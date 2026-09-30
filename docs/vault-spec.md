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

Privacy labels communicate policy but do not encrypt files. A deployment must enforce filesystem and network access separately.

Tasks live in one canonical project or area note. Session notes contain evidence and link to that task. Decisions retain rationale and status. Unknown facts remain blank.
