# Handoff: Floor 1 pistol seed-5 release loss

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree

## Apples

2🍎 (small targeted AI-priority fix + deterministic regression coverage)

## Summary

Resolved release-sweep loss signature `floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=5|weapon=pistol` from run `32642094156` (`project:sweep-results-viewer runId=32642094156`) without weakening gates or disabling settlement-return routing.

Root cause: Floor 1 settlement-return Progress routing could preempt the staircase-boss phase as soon as the first boss objective was complete, pulling the run off the critical boss chain in seed 5 pistol runs and leading to a death at ~355s.

Fix: gate Floor 1 settlement-return Progress routing behind both boss encounters being defeated, matching the existing post-boss spell-broker-return gate and preserving objective-chain priority.

Added deterministic coverage for the exact regressed signature by extending the Floor 1 release-loss regression panel with `pistol seed 5`.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
- `tests/headless/floor1-release-sweep-loss-regressions.test.ts`

## Verification run

- `npm run ai:headless:tsx -- --seed 5 --weapon pistol --floor floor1 --max-frames 39600 --max-time 300000 --settlement-return-routing` (before fix) — **death** at frame 21,319 / 355.3s.
- `npm run ai:headless:tsx -- --seed 5 --weapon pistol --floor floor1 --max-frames 39600 --max-time 300000 --settlement-return-routing` (after fix) — **victory** at frame 35,558 / 592.6s.
- `npx vitest run --project headless tests/headless/floor1-release-sweep-loss-regressions.test.ts --reporter=verbose` — passed (5/5, includes new `pistol seed 5` case).
- `npx vitest run --project headless tests/headless/settlement-return-routing.test.ts -t "enables Floor 1 settlement-return routing when the option is omitted" --reporter=verbose` — passed.
- `bash scripts/agent/verify-fast.sh` — passed.
- `npm run verify:pr-prereqs` — initially failed due missing handoff, now expected to pass for a 2🍎 code-touching change with no review ledger required.

## Unresolved issues

- Could not post the requested issue-plan comment via local `gh issue comment` because `GH_TOKEN` is not available in this sandbox.

## Recommended next steps

- Let CI execute the full release/reporting matrix and confirm Floor 1 release leg returns to 100%.
