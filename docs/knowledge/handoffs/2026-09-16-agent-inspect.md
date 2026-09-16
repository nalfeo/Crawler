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

`npm run scope`, `npm run verify:fast`, and the TypeScript-run command itself
are blocked on this host before project code runs: Node 24 reports
`uv_os_get_passwd returned ENOMEM` while tsx initializes its temporary directory.

## Unresolved issues

The host-level tsx initialization failure prevents completing `verify:fast` and
local CLI smoke execution in this worktree. Focused Vitest tests, TypeScript
typecheck, and ESLint are green.

## Recommended next steps

Have CI run the normal PR checks. If the tsx error reproduces outside this
desktop sandbox, repair the host account-memory/temporary-directory condition
and rerun `npm run verify:fast`.
