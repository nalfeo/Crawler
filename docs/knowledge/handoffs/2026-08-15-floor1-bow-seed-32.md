# Session Handoff: Floor 1 Bow Seed 32 Retreat Bias

## Date

2026-08-15

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Summary

Issue #2987 reported the forced-bow seed 32 Floor 1 loss from release run
`31887873050` (`project:sweep-results-viewer runId=31887873050`). The exact
current-baseline replay died at frame 12,716 with 2.9% minimum HP; the same tuple
at previous baseline `48a515cd183b7988d2b66235e1a6ee876221793d` won.

The gameplay regressor was PR #2960's retreat candidate score, not the later CI
commit named by the automated issue. It added raw progress toward a remembered
objective directly to enemy clearance. A remote Spell Broker objective could
therefore outweigh a materially safer retreat lane.

The fix normalizes objective progress by candidate travel distance. Reverse
triangle inequality bounds that fraction to `[-1, 1]`, so route awareness can
trade at most the existing retreat hysteresis band of enemy clearance. No
weapon, enemy, damage, deadline, seed list, sweep, or gate value changed.

## Real-pipeline evidence

Observed through `src/game/ai/headless-runner.ts` with the release configuration:
forced bow, seed 32, damage multiplier 1, and the unchanged 23,760-frame cap.

- Before: death at frame 12,716, 211.9 seconds, 2.9% minimum HP.
- After: official victory at frame 14,786, 246.4 seconds, 37.5% minimum HP.
- Paired post-fix runs are identical after excluding `wallTimeMs`.
- Nearby bow seed 31 and non-bow sword seed 32 remain official victories.
- Prior bow-35, baseball-bat-34, and throwing-knife-44 retreat regressions remain
  official victories.

## Regression coverage

- `tests/game/behavior-tree-ai.test.ts` proves route bias still improves a
  comparable retreat lane and cannot surrender more safety than the live
  hysteresis band when the objective points toward danger.
- `tests/headless/floor1-retreat-objective-bias-regressions.test.ts` adds the
  exact bow-32 release tuple, shared budget constants, official-win assertion,
  and paired deterministic replay.

## Validation

- Focused retreat unit tests: 3 passed.
- Exact Floor 1 retreat headless regressions: 4 passed.
- Healthy-case CLI panel: bow-31 and sword-32 won.
- `bash scripts/agent/verify-fast.sh`: passed (138 files, 2,259 tests).
- Code review: clean after two rounds.
- Independent grade: pending rerun after pre-publish sync and this handoff.

## Review

Plan review by `gpt-5.4` produced minor refinements. Code review round 1 raised
one mathematical concern that was resolved by documenting the reverse triangle
inequality; independent round 2 by `claude-sonnet-4.6` was clean. The first
independent grade correctly blocked on stale-main diff scope and missing
publication artifacts; both were addressed before re-grading.

## Blockers

None known.
