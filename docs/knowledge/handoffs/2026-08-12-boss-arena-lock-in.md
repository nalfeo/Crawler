# Session Handoff: Floor 1 Boss Arena Lock-In Gates

## Date

2026-08-12

## Persona

Game AI Engineer

## Systems touched

ai-headless-runner, boss-rooms

## Apples

4🍎 estimated, 4🍎 actual (exact).

## Problem

Weapon sweep run 29453994290 at SHA
`9ef7730f3cd742c7719823262b5243d5464a73e9` exposed a Floor 1 boss failure
class: baseball-bat seed 25 and sword seed 44 died after ineffective boss
commitment, while baseball-bat seed 67 timed out and later died in an arena
kite/lock-in deadlock.

The exact cloud artifacts establish the historical baseline:

- baseball-bat seed 25: death at 144.43 seconds;
- sword seed 44: death at 316.90 seconds;
- baseball-bat seed 67: timeout at 396 seconds.

Local execution of the historical SHA was blocked before simulation because it
requires the removed `recast-navigation@0.43.1`, and the registry could not
retrieve that package. The downloaded exact-SHA sweep artifacts remain the
baseline evidence.

## What Was Done

- Added optional `RunStats.floor1BossProgression` lifecycle telemetry sourced
  from the production Floor 1 `bossBattles` state. It records boss entity id,
  first-start frame/time, player level and health fraction at entry, and first
  defeat frame/time.
- Added the telemetry to both normal and error `runHeadless` return paths.
- Strengthened the real-headless legacy regression suite with the three exact
  weapon/seed cases at the existing 19,800-frame sweep budget.
- The gate requires an official victory, both named encounters started and
  defeated, level >= 2 and health >= 50% at entry, each fight completed within
  60 seconds, and a sampled decision proving the lifecycle-captured boss entity
  became the explicit `Boss-room lock-in` target.
- No combat values, target selection, hunt behavior, generic ranged spacing, or
  runtime AI decisions changed.

## Real-Pipeline Evidence

Observed through `runHeadless` and the production AI simulation step:

| Case            | Outcome | Frames | Slime-rat entry   | Slime-rat fight | Staircase entry   | Staircase fight |
| --------------- | ------- | -----: | ----------------- | --------------: | ----------------- | --------------: |
| baseball-bat 25 | victory | 14,489 | level 2, 93.5% HP |             757 | level 5, 62.7% HP |             731 |
| sword 44        | victory | 14,401 | level 2, 71.7% HP |             607 | level 3, 66.8% HP |             516 |
| baseball-bat 67 | victory | 14,691 | level 2, 84.8% HP |             744 | level 5, 92.8% HP |             641 |

All three complete within the original sweep budget and avoid the historical
premature/ineffective commitment and arena deadlock modes.

## Review

- Adversarial plan review (`gpt-5.4`) produced a major fork from parsing sampled
  reason strings to stable production lifecycle telemetry.
- Single-model code review (`claude-sonnet-5`) found no code defects.
- Multi-model review (`gpt-5.5`, `gemini-3.1-pro-preview`) found one valid
  test-only concern: sampled intermediate boss health was redundant and could
  be missed by the 15-frame event cadence. The assertion was removed while the
  explicit boss-target assertion, defeat state, and bounded fight duration were
  retained. Both reviewers returned clean on round 2.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-08-12-boss-arena-lock-in.review-ledger.json`.

## Validation

- Focused Floor 1 legacy headless regressions: 8/8 passed.
- `npm run typecheck`: passed.
- `npm run verify:fast`: passed.
- `npm run check:wired-systems`: passed.

## Blockers

None for publication. Exact local execution of the historical SHA remains
unavailable because its removed navigation dependency cannot be restored, but
the exact cloud artifacts and current real-headless reproductions provide the
before/after evidence.
