# Floor 4 completion contract baseline

## Date

2026-09-03

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree

## Apples

3🍎 estimated, 3🍎 actual (exact). The slice added shared dual-runner acceptance
evidence and no gameplay, scenario, tuning, or runtime behavior changes.

## What Was Done

- Added a shared Floor 4 completion assessment for the ordered acceptance
  criteria and the first failed criterion.
- Updated the seed-404 production headless and visual AI-runner baselines to
  capture complete relevant telemetry and assert their current evidence.
- Recorded the assertion map in
  `.specify/specs/floor4-playable-completion.md`.

## Observation

Observed in the real production headless runner: seed 404 reached `VICTORY`
with `RunStats.outcome: 'victory'` at frame 36,487; all five Headliners spawned
and died, and physical feed-gate waves spawned. Observed in the real
`ai-runner-lab` `MainGameScene`: the same seed reached `VICTORY` with the same
completion facts.

Both artifacts first fail `intermission-public-interaction`: the transition
following each intermission reports `slice2-auto-green-room-exit`, and the
last reports `slice2-auto-stairs`. This is shared scenario behavior, not a
runner discrepancy. The visual artifact does not produce `RunStats`; its
production scenario phase is recorded separately.

## Verification

- `npm run typecheck` ✅
- `npx vitest run tests/headless/floor4-arena-completion.test.ts --reporter=verbose` ✅
- `npx vitest run --project e2e tests/e2e/floor4-ai-completion.deterministic.test.ts --reporter=verbose` ✅

## What's Next

The Green Room and final-stairs interaction slice must replace the timer-driven
transitions through production scenario/UI behavior. It should preserve this
shared contract and make `intermission-public-interaction` pass without adding
test-only shortcuts.
