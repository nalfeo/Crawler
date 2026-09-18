# Handoff: Cost-aware task routing

**Date:** 2026-09-16

## Systems touched

docs-tooling

## Completed

Added `npm run task:route`, a deterministic, on-demand recommendation tool for
an explicitly declared task class. It emits a model, reasoning effort, bounded
model/tool-loop cap, escalation condition, and stable telemetry (plain text or
`--json`). It is advisory only: it does not inspect or apply Codex app, account,
project, or global settings.

The baseline routes are Luna/low for narrow telemetry reports; Terra/low for
routine tooling or docs; and Terra/medium for bounded implementations. Sol is
available only through `complex-escalated`, which requires a recorded
complexity/escalation reference and is capped at 10 loops. Routine routes never
recommend a flagship model.

The compact policy is in
`docs/agent-os/policies/task-routing-policy.md`; `AGENTS.md` was intentionally
unchanged because the command is on-demand and its existing startup contract
does not need another mandatory step.

## Validation

- `npx vitest run --project unit tests/unit/task-routing.test.ts --reporter=dot`
  — pass (6 tests), covering all baseline maps, Sol evidence enforcement, and
  invalid CLI input.
- Direct `npm run task:route` checks under the host workaround — valid JSON
  route and missing-Sol-evidence failure observed.
- Targeted Prettier and ESLint — pass.
- `npx tsc --noEmit` — pass.
- `npm run verify:fast` — pass under a process-local workaround for the
  sandboxed Windows Node `uv_os_get_passwd` ENOMEM fault.
- `npm run scope` — completed; it conservatively classified the change as broad
  because of its test hook, not because game/runtime paths changed.
- `npm run docs:check` is blocked by the pre-existing missing
  `docs/agent-os/policies/complexity-policy.md` reference in ADR 0043.
- `npm run preflight` was invoked as required, but its dirty-worktree bootstrap
  repeatedly removed `.bin` during dependency installation in this sandbox;
  dependencies were restored afterward. No repository runtime code was changed
  to work around that host issue.

## Review

Routine, reversible tooling/docs change; independent review is not required by
the change-risk policy. The policy map and CLI parsing are covered by focused,
deterministic tests.

## Remaining

The publication branch was rebased onto current `origin/main`; focused tests and
`verify:fast` were rerun afterward, and the full ESLint + PR-prerequisite check
passed. Publish the ready-for-review PR. The existing ADR 0043 documentation
defect should be repaired in a separate scope.
