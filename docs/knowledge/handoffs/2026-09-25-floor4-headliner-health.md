# Floor 4 Headliner health

## Date

2026-09-25

## Persona

Producer coordinating Game Designer tuning and QA verification.

## Systems touched

floor4-arena, enemies, ai-combat-balance, headless-runner

## Summary

Issue #4519 exposed that Floor 4 Headliners still used their original raw
130–300 HP values after the merged gear-score and nearby-density work increased
the production automatic-combat build's damage and income. In the canonical
seed-404 production run, the Act 1 Mascot Mauler died in 4.77 seconds, before
its 9.3-second first ability window.

Headliners now have per-candidate authored health values sized for the current
act build curve. `Floor4HeadlinerTelemetry` records each physical encounter's
start and defeat times, and a deterministic production-headless gate derives
the minimum fight time from every selected ability's first-eligible delay plus
telegraph duration. It also preserves the 30-second normal headline window and
requires the canonical run to remain a victory.

## Evidence

- Baseline seed 404: Mascot Mauler duration 4.77s versus required 9.3s.
- Corrected `floor4-headliner-survival-gate`: passed; every selected Headliner
  survived its opening authored mechanic and stayed within 30 seconds.
- `tests/headless/floor4-arena-completion.test.ts`: 2 passed.
- `npm run typecheck`: passed.
- `npm run verify:fast`: passed.
- The Floor 4 MainGameScene deterministic completion test was launched with
  Chromium desktop permission; retain its final result in the PR description.

## Notes

The change preserves automatic combat, deterministic replay, safe-room rules,
phase boundaries, and overtime. No art asset changed.

## Recommended next steps

Run the Floor 4 lab gate required by PR preflight, complete the final
`verify:pr-prereqs` pass and complete-diff Ducky review, then publish the
ready-for-review PR linked to #4519 without auto-merge.
