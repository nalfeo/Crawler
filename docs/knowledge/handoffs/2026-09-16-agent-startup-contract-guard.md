# Handoff: Agent startup contract regression guard

**Date:** 2026-09-16

## Systems touched

docs-tooling, agent-validation

## Completed

Added `check:agent-startup-contract`, a deterministic check over the checked-in
root `AGENTS.md`. It prints the measured character count and a 12,000-character
ceiling, then fails on either an oversize contract or known bloat shapes:
exhaustive command-catalog headings and mandatory bulk-reading instructions.

The current contract measures 6,874 characters, leaving 5,126 characters of
headroom. The ceiling is deliberately well above the compact contract while
still preventing recurrence of the former roughly 55,000-character startup
prompt. The check reads no session logs or external state.

It is exposed as a focused npm command and included in the existing `docs:check`
aggregate. Fixture-backed unit tests cover a compact pass case, size failure,
and prohibited-pattern failure.

## Validation

- `npx vitest run --project unit tests/unit/agent/agent-startup-contract.test.ts --reporter=dot` — pass (3 tests).
- Targeted ESLint — pass.
- Targeted Prettier check initially identified formatting; `prettier --write`
  was applied.
- The direct `tsx` command and `npm run scope` are blocked in this Windows
  environment before project code executes by Node 24's
  `uv_os_get_passwd` ENOMEM error. The same checker logic is exercised by the
  passing Vitest suite.
- Repository-wide `typecheck` is blocked by pre-existing errors in
  `handoff-retrieval.test.ts` and `producer.test.ts`; neither file is touched.

## Remaining

Run `npm run check:agent-startup-contract`, `npm run docs:check`,
`npm run verify:fast`, and `npm run verify:pr-prereqs` in an environment where
the `tsx` launcher can initialize, then publish the staged, focused change.
