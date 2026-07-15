# Handoff — fix(sweep): count all victories as wins; track slow clears separately

## Summary

Fixed issue #1146: the Floor 1 win-rate sweep was conflating slow victories (outcome=victory
but active time ≥ 6-min budget) with true losses, silently understating the outcome win rate.

Before: baseline `by-sha/88828e6...` reported 33 failures but 15 were victories — the "official
win" classification (victory AND under budget) was used as the win-rate numerator, so those 15
over-budget victories counted as losses.

After: any run with `outcome === 'victory'` counts as a win. Over-budget victories are separately
flagged as "slow clears" and shown in a dedicated diagnostic section — they never appear in `fails`
or reduce the reported win rate.

## Changes

### New file

- `scripts/agent/perf/winrate-sweep-classify.ts` — pure, side-effect-free module exporting
  `SweepRunClassification` interface and `classifySweepRun(stats, floorId)` function. Extracted
  from `winrate-sweep.ts` so the classification logic is unit-testable without launching a sweep.

### Modified

- `scripts/agent/perf/winrate-sweep-args.ts` — `FLOOR1_TIME_BUDGET_MS` is now exported (was `const`).
- `scripts/agent/perf/winrate-sweep.ts`:
  - Win count uses `outcome === 'victory'` (outcome win), not `isOfficialWin`.
  - `SweepTaskResult` carries `outcomeVictory`, `officialWin`, `slowVictory`, `slowRecord`.
  - `RunMetric` carries `slowVictory: boolean`.
  - Progress bar: `.` fast win, `s` slow victory, `F` true loss.
  - Per-weapon summary table gains `Slow` column.
  - Summary footer shows breakdown: "N fast wins · N slow victories · N true losses".
  - Quality section: `FAST WINS` / `SLOW WINS` (conditional) / `LOSSES`.
  - Failures section: `❌ N true failures` then `⏱️ N slow victories` (separate).
  - JSON `--out` fields added: `totalSlowVictories`, `totalTrueLosses`, `slowFails`,
    `aggregate.slowVictories`.
- `scripts/agent/perf/format-baseline-comment.ts`:
  - `Baseline` interface gains optional `totalSlowVictories?: number` and `totalTrueLosses?: number`.
  - When those fields are present, `formatBaselineComment` appends a breakdown line:
    `  ↳ N fast wins · N slow victories · N true losses`.
  - Backward compatible — old baselines without these fields show no breakdown.

### Tests

- `tests/unit/winrate-sweep-classify.test.ts` (new — 8 tests):
  - Fast win, safe-room-credited fast win, over-budget slow victory, true loss (timeout/death),
    floor2 victory, floor2 loss.
  - Acceptance-criteria test: over-budget victory → wins=1, losses=0, slowVictories=1.
- `tests/unit/format-baseline-comment.test.ts` (updated — 2 new tests):
  - Baseline with slow-victory breakdown fields → comment contains breakdown line.
  - Baseline without those fields → no breakdown line (backward compat).

## Verification

`npm run verify:fast` passed (317 unit test files, 87 integration test files, 3736 + 1199 tests).
All 47 tests in the 4 directly related test files pass.

## Systems touched

ci-policy, perf

## Apples

🍎🍎 estimated, 🍎🍎 actual — exact.

## Unresolved issues

None.
