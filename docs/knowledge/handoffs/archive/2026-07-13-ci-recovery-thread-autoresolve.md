# Session Handoff: CI recovery thread auto-resolve trust fix

## Date

2026-07-13

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

- Added `copilot-swe-agent` (without the `[bot]` suffix) to the trusted bot login set used by CI recovery review-thread resolution.
- Added a focused state test proving `shouldResolveThread()` accepts a valid `✅ Addressed in <sha>` marker authored by `copilot-swe-agent`.
- Reproduced the blocker locally with the PR #1112 thread shape before the fix (`shouldResolveThread(...) === false`) and verified the targeted and fast verification suites pass after the fix.

## Key Decisions Made

- Kept the `✅ Addressed in <sha>` marker contract unchanged; the bug was in trusted-author recognition, not marker parsing.
- Chose the smallest deterministic fix: widen the trusted Copilot login allowlist rather than broadening resolution heuristics.
- Added a regression test at the `state.mjs` layer because the failure was in thread-resolution policy, not in the issue-intake script itself.

## Verification Run

- `node --test .github/scripts/ci-recovery/state.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-13-ci-recovery-thread-autoresolve.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved Issues

- None.

## Recommended Next Steps

- Let CI recovery re-run on PR #1112 so the existing `✅ Addressed in 827f665` thread reply can be auto-resolved.
