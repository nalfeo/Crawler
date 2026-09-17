# Cost-aware task-routing policy

Before creating a Codex task, an orchestrator explicitly declares one task class and obtains an advisory recommendation:

```bash
npm run task:route -- --class routine-tooling-docs
```

The command is deterministic, has no network calls, and reports stable telemetry. It **does not** read or change Codex app, account, project, or global model settings. The orchestrator remains responsible for creating the task and applying its own allowed configuration.

| Task class                | Model           | Reasoning | Maximum model/tool loops |
| ------------------------- | --------------- | --------- | ------------------------ |
| `narrow-telemetry-report` | `gpt-5.6-luna`  | low       | 3                        |
| `routine-tooling-docs`    | `gpt-5.6-terra` | low       | 5                        |
| `bounded-implementation`  | `gpt-5.6-terra` | medium    | 8                        |
| `complex-escalated`       | `gpt-5.6-sol`   | medium    | 10                       |

`complex-escalated` is the only Sol route. It requires a non-empty, recorded complexity or escalation reference, for example a PR, failed validation, incident, or prior capped attempt:

```bash
npm run task:route -- --class complex-escalated --evidence "PR #123: Terra reached its loop cap"
```

At the printed escalation condition or loop cap, stop and reclassify the work with evidence rather than silently increasing the budget. Routine loops must never be routed to a flagship model. Use `--json` when an orchestrator needs machine-readable output.
