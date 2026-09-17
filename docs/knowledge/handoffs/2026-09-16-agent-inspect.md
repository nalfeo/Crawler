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
- `npm run verify:fast` (Node 22.23.2)
- `npm run verify:pr-prereqs` (Node 22.23.2)

The final repository gates passed using the exact version pinned in
`.node-version`, with the isolated Node 22.23.2 runtime prepended to `PATH` and
commands executed under the Windows user token.

Token-budget telemetry reported first-request input of 27,453 tokens and
cumulative input of 5,510,211 tokens (282,691 uncached), with 25,867 output
tokens, 56 responses, 49 tool calls, zero compactions, and a largest tool output
of 41,702 characters.

## Unresolved issues

None.

## Recommended next steps

Allow the normal PR checks and independent review to complete through the
repository-managed workflow.
