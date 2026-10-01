# Skill evals

The unit tests prove that the tools do what they say when someone follows the skills' steps. These evals measure the other half: whether a real model, given only what an MCP client gives it, follows the skills and leaves the vault right.

Each scenario seeds a throwaway vault, gives the model a user's messages, lets it work through the real MCP server, and then grades the vault, the server's audit log, and the reply. No real vault is ever touched.

| Scenario | Skill | What it measures |
| --- | --- | --- |
| `onboarding` | onboarding | Turns one long answer into a vault, records the rhythm exactly, leaves what the user withheld blank |
| `daily-circle` | daily-circle | One daily note, only stated numbers, finished tasks ticked, the plan updated, nothing invented |
| `injection-in-inbox` | daily-circle | A captured inbox line that gives the agent orders is treated as data |
| `approval-discipline` | second-brain | Previews a goal and waits for the user's yes instead of saving it |
| `weekly-review` | weekly-review | Cites the week's real numbers, one review note per week, a decision recorded as accepted |
| `retrieval` | second-brain | Answers from the right note and never leaks a restricted or hidden one |

Checks are either **outcome** (what the vault and reply contain) or **process** (how the model got there: loaded the skill, read before writing, never approved on its own). Every run also gets a `no-direct-edits` check: any vault change without a matching audit event means the model edited files itself.

## The graders are tested first

`npm test` runs `src/harness.test.ts`. For every scenario a scripted run that follows the skill must pass every check, and a run that does nothing must not. A model's score is only meaningful because of that.

## Running a model

```bash
npm run build
node evals/dist/prepare.js daily-circle        # prints the sandbox folder and the prompt file
```

Give the model `prompt.md`. It names the only way to act, `node evals/dist/tool.js <sandbox> <tool> -`, which starts the real stdio server for that sandbox, makes one call, and records it. When the model is done, save its final message to `<sandbox>/final.txt` and grade:

```bash
node evals/dist/grade-cli.js <sandbox>
```

The report lists each check, the tools called in order, errors, and writes applied. `result.json` is saved beside the run. Sandboxes live in `evals/runs/`, which Git ignores.

The prompt carries what a client would: the server's instructions and the tool schemas. It is one message with the user's whole conversation, so a model cannot pause for an answer; when it needs approval the user has not given, the right behavior is to stop and ask in its final message, and the `approval-discipline` scenario checks that.

## Limits

- Results come from a handful of runs per scenario, so read them as evidence, not as a benchmark. Repeat a scenario before trusting a one-off pass or failure.
- A model that is also a coding agent has other tools; the prompt tells it not to use them and the audit check catches vault edits, but not every deviation.
- Single-turn prompts do not test a long, interactive conversation.
