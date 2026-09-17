# Handoff: Agent context and ceremony reduction

**Date:** 2026-09-16

## Systems touched

docs-tooling, agent-validation, agent-personas, ci-policy

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

Retired the Apple estimation and calibration system from active workflows. The
change removes estimates and scores from agents, skills, personas, Goobers
contracts, producer decomposition, PR preflight, velocity analytics, and durable
memory. It deletes the record/calibration commands and tests, while leaving old
handoffs and metrics as inert historical evidence.

Review now has one trigger: architectural changes or changes with meaningful
correctness, security, data-loss, determinism, or release risk receive one
independent post-diff review. Routine changes rely on focused tests and CI.
A regression test rejects reintroduction of the retired machine-readable fields
and policy links in active sources.

## Validation

- `npx vitest run --project unit tests/unit/agent/agent-startup-contract.test.ts --reporter=dot` — pass (3 tests).
- Focused policy, producer, contract, velocity, and documentation tests — pass
  (234 tests); two Goobers process-spawn cases were unable to start a child
  process under the host resource fault described below.
- Goobers contract schema validation — pass (9 workflows, 39 fixtures).
- PR-preflight and review-policy Node tests — pass (30 tests).
- `npm run verify:pr-prereqs` — pass, including repository lint.
- Targeted ESLint — pass.
- Targeted Prettier check initially identified formatting; `prettier --write`
  was applied.
- `npm run verify:fast` — pass under the elevated Windows user token. The
  earlier `uv_os_get_passwd` ENOMEM result came from running Node under the
  sandboxed token, not from repository code or the host environment.
- Pre-publish main sync rebased the publication branch onto current
  `origin/main`.
- Published CI passed, including lightweight checks, unit tests, integration
  tests, visual checks, security checks, and the merge gate.

## Remaining

PR #4599 is published and ready for review.
