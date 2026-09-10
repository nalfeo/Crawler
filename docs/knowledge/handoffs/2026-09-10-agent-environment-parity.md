# Agent Environment Parity

## Date

2026-09-10

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 3🍎. Exact: the change added a shared bootstrap, Codex
environment, runner wiring, and a deterministic drift gate.

## What changed

- Added canonical Node and Python version files plus one cross-platform agent
  environment bootstrap.
- Made GHCP, the normal sprite CI runner, and Codex consume the shared contract.
- Added an environment parity command and focused regression tests.
- Documented how to update and validate the environment contract.

## Evidence

- `npm run environment:check` passed (5 tests).
- Focused parity, setup-node, and sweep-provenance suites passed (42 tests).
- `node --check scripts/agent/setup-environment.mjs` passed.
- `npm run verify:fast` passed outside the restricted sandbox. The first attempt
  could not start because Node's host-user lookup returned `ENOMEM` in the
  sandbox before repository validation began.

## Follow-up

Run `npm run verify:fast` under Node 22 or rely on the pinned GitHub runner. A
Codex worktree host must activate Node 22 and Python 3.12.10 before setup; the
bootstrap reports mismatches explicitly.
