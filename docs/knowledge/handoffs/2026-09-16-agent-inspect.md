# Agent inspection batch command

**Date:** 2026-09-16  
**Persona:** DevOps Engineer  
**Apples:** 3🍎 estimated / 3🍎 actual (exact)

## Systems touched

agent-workflow-tooling, agent-contract

## Summary

Added `npm run agent:inspect -- --manifest <relative-json-file>`, a deterministic
read-only batch inspection command for agent discovery work. It accepts a bounded
ordered manifest of file excerpts, literal ripgrep searches, package-script
lookups, and worktree status. Each section and the combined result are capped;
invalid individual requests report a bounded error without hiding later evidence.

Manifest values are never interpreted by a shell. Paths are confined to the
repository root (including resolved symlink targets), and the only subprocesses
use fixed executables and fixed argument shapes.

## Files touched

- `scripts/agent/inspect.ts`
- `tests/unit/agent-inspect.test.ts`
- `package.json`
- `AGENTS.md`

## Verification

- `npm run test:unit -- tests/unit/agent-inspect.test.ts tests/unit/bounded-output.test.ts --reporter=dot`
- `npm run typecheck:src`
- `npx eslint scripts/agent/inspect.ts tests/unit/agent-inspect.test.ts --max-warnings 0`
- `git diff --check`
- `npm run apples:record -- --session agent-inspect --estimated 3 --actual 3`

`npm run verify:fast` runs under the Windows user token but currently fails on
pre-existing type errors in `tests/unit/agent/handoff-retrieval.test.ts`: its
imported `.mjs` module lacks three expected exports and consequently leaves
three callback parameters implicitly typed as `any`.

## Unresolved issues

No rollout telemetry file exists in this worktree, so first-request and
cumulative-input telemetry is unavailable. The current token-budget CLI accepts
a rollout file argument; it does not support the previously attempted
`--rollout` flag.

## Recommended next steps

Have CI run the normal PR checks. Separately repair the missing exports in the
handoff-retrieval module before relying on `verify:fast` as a local green gate.
