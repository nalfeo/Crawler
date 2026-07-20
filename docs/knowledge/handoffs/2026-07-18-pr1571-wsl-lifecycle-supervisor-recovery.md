# Handoff: PR #1571 WSL lifecycle supervisor recovery

## Date

2026-07-18

## Persona

Producer

## Systems touched

ci-policy

## Apples

- Estimate: 2🍎
- Actual: 2🍎

## Summary

- Reworked `tests/unit/verify-fast-typecheck.test.ts` lifecycle coverage to run signal delivery, PID-file checks, and descendant `kill -0` assertions from a Bash supervisor process instead of Node-side `proc.kill/process.kill`.
- Kept the existing descendant-stub hooks in `verify-fast.sh` and verified cleanup behavior by asserting the supervisor-observed child PIDs terminate after the verifier receives a termination signal.
- Documented the supervisor signal choice: this path uses SIGTERM/exit-143 because async non-interactive Bash jobs can ignore SIGINT across host→WSL launch boundaries, while still exercising trap-driven cleanup and descendant shutdown in one POSIX namespace.
- Added explicit supervisor failure diagnostics so regressions show deterministic stdout/stderr context.
- Recorded a 2🍎 review ledger with intentionally empty `stages` (below the 3🍎 stage floor per review-harness policy).

## Before / after observation

- Before: lifecycle test orchestrated signals and PID liveness from Node, which cannot reliably represent Windows→WSL PID/signal semantics.
- After: lifecycle orchestration and PID namespace checks execute entirely inside Bash, matching the supported POSIX path and removing host-namespace assumptions.

## Verification

- `npx vitest run --project unit tests/unit/verify-fast-typecheck.test.ts --reporter=verbose`
- `npm run verify:fast`

## Unresolved issues

- None.
