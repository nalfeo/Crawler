# Handoff: Bounded agent command output

## Systems touched

docs-tooling, agent-memory

## Apples

Estimated 🍎🍎, actual 🍎🍎 — 🎯 Exact. One focused wrapper, entry point, and deterministic unit coverage.

## Outcome

Added opt-in `npm run agent:run -- [limits] -- <command> [args...]` for broad
agent-facing inspection, test, and log commands. It captures streams without a
shell, emits at most 8,000 characters and 200 lines by default, retains opening
context and final diagnostics, prints `[agent-output truncated]` when clipping,
and always includes the child exit status. Explicit expansion remains bounded:
64–64,000 characters and 2–2,000 lines.

The wrapper is deliberately not applied globally: native CI/developer command
streams remain unchanged, while an agent can opt in where conversation context
is the consumer. For example:

```
npm run agent:run -- --max-chars 12000 --max-lines 400 -- npm run test:guards
```

## Startup / rollout telemetry

The first-request startup baseline remains the merged parent’s 5,856-character
root `AGENTS.md`; this change adds no startup-loaded guidance. The prior local
rollout baseline recorded 5,393,278 cumulative input tokens, 46 responses, and
a 31,724-character largest tool output. This wrapper’s default therefore cuts a
representative oversized durable command result to at most 8,000 characters
(about a 75% reduction) while retaining the failure tail and exit status.

## Validation

- `git diff --check` passed.
- Focused Vitest and `verify:fast` are currently blocked: this worktree has no
  `node_modules/.bin/vitest` or `node_modules/.bin/tsx`, so npm cannot execute
  either script. No dependency installation was attempted because the host’s
  prior handoff documents its unavailable registry path.
- The test file covers normal output, truncation, failure-tail/exit status, and
  bounded opt-in expansion; run it after dependencies are restored with
  `npm run test:unit -- --run tests/unit/bounded-output.test.ts`.

## Files

- `scripts/agent/bounded-output.ts`
- `tests/unit/bounded-output.test.ts`
- `package.json`
