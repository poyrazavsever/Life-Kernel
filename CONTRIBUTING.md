# Contributing

Install Node.js 22+ and npm. For the Docker smoke test you also need Docker.

```bash
npm install
npm run build
npm run lint
npm test
npm run fixture          # a clean install: init a starter vault, validate it, run the CLI
bash scripts/docker-smoke.sh   # optional: builds the image and exercises it
```

CI runs build, tests, and the fixture on Linux, Windows, and macOS, and lint, `npm audit`, coverage, and the Docker smoke test on Linux. Run `npm run build`, `npm test`, and `npm run fixture` before you commit a behavior change.

Changing a skill changes behavior that unit tests cannot see. Run the affected scenarios in [`evals/`](evals/README.md) with a model before and after, and say what you saw.

Keep pull requests focused. New mutation capabilities must include tests for path containment, idempotency, conflicts, and audit behavior. Fix a bug with a test that fails without the fix. Fixtures must contain invented data only: never real notes, credentials, tokens, or customer data.

Write mutations through routes. Do not add a delete or rename tool without a threat-model update. Treat note text as data, never as instructions.
