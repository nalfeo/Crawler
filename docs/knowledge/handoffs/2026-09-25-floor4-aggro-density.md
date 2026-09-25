# Floor 4 nearby combat density

## Date

2026-09-25

## Persona

Producer coordinating Game Designer tuning, Game AI Engineer pipeline parity,
QA regression coverage, and independent Reviewer checks.

## Systems touched

enemies, ai-combat-balance, floor4-arena

## Recommendation and scope

Recommended: approved issue #4517 requests roughly ten enemies in aggro range
except bosses and intermissions. Built on merged #4655 Headliner mechanics,
#4667 gear scoring, and #4384 cadence. No new art or ECS system was needed.
ADR 0111 records the shared director design and its review constraints.

## Implementation

- Wave enemies now pursue from their feed gate throughout the arena. Ranged
  attack distance, Headliner mechanics, and safe-room AI protection are unchanged.
- Scheduled waves/debt retain priority. A separate immutable seed/act reserve
  supplies one pending telegraphed batch at a time, split between the committed
  two nearest gates with a full one-second warning. Pressure is rechecked before release.
- Authored bounds: nearby refill high-water 20 within 60 feet, incoming cap 24,
  batch size four, interval 1,000 ms, reserve 320 per act, hard live cap 24,
  and authored debt cap 18. Reserve batches never enter debt or catch up in a loop.
- A five-second moving average reduces the refill threshold by twice sustained
  excess above eleven. Scheduled intake waits above eleven too, and adaptive
  intake cannot bypass waiting authored debt. This compensates travel while
  bounding sustained pressure; the acceptance range is 8–12 per act.
- Safe rooms, tunnels, dead players, terminal states, and phase exits cancel
  pending pressure. Entity-generation ownership prevents recycled IDs from being
  counted or cut as stale wave enemies.
- Existing lab exposes all pressure knobs; MainGameScene probe independently
  counts nearby living hostiles. Ordinary automatic combat and rewards apply.

## Observed evidence

The headless observer leaves movement, health, damage, and combat untouched.
Samples include every active non-safe WAVES frame, including initial travel.

| Seed | Baseline per-act nearby averages | New per-act nearby averages   | New overall | Result                   |
| ---- | -------------------------------- | ----------------------------- | ----------- | ------------------------ |
| 404  | 0.05, 2.09, 1.76, 1.88, 1.78     | 10.03, 9.65, 8.31, 9.22, 9.56 | 9.35        | Victory                  |
| 1    | 0.12, 3.27, 2.35, 2.59, 2.89     | 9.73, 9.91, 8.62, 8.45, 8.74  | 9.09        | Victory                  |
| 2    | 0.30, 3.45, 2.62, 2.00, 2.95     | 9.39, 9.79, 8.77, 9.73, 11.85 | 9.90        | Death at fifth Headliner |

All three reached all 50 scheduled wave releases and stayed at or below 24
hostiles. Peak simultaneous projectiles were 2/0/0. Seed 404 replay matches the
complete observation and director timeline exactly. First ten nearby enemies
occur during initial gate travel; later-act arrival varies with player travel.

Real MainGameScene Act 1 baseline averaged 0.49 nearby enemies (78 observed
samples, peak two). The final paused-step test records all 90 wave seconds,
averages 10.81 (peak 22), and transitions to HEADLINE with one living enemy.
The captured screenshot shows active automatic combat and gate-fed enemies.
Green Room purchasing and public next-act confirmation still pass.

Every tested act passes 8–12; this is not a per-frame guarantee for every
possible build. Ordinary kills increased from 286/258/303 to 1171/1092/1134; ordinary
XP/drop income therefore increases too. Seed 2's final-boss death is retained as
balance evidence, not hidden by forced health or a weakened completion gate.

## Validation

- Preflight passed after retrying dependency installation with host access.
- Typecheck passed.
- Focused unit: 6 files, 97 tests passed, including 17 new pressure regressions.
- Headless: 4 files, 19 tests passed, covering pressure/replay, wave lifecycle,
  all nine Headliners, and canonical production-AI Floor 4 completion.
- MainGameScene E2E: 2 files, 3 tests passed, covering density and Green Room.
- `npm run scope` selected simulation, integration, coverage, and visual checks;
  the focused real pipelines above cover this Floor 4 change.
- Required fast verification, PR prerequisites, and complete-diff reviews are
  recorded in the PR description after their final runs.
- Independent review caught a floor-wide averaging blind spot. Per-act assertions
  now prevent it; two-gate spread and feedback across both intake paths resolved
  the actual under/oversupply. Final independent code review has no findings.
- Guard telemetry was unavailable (`files/guard-telemetry.jsonl` absent).

## Handoff

Publish ready for review linked to #4517, without auto-merge. Release local
ownership immediately after publication; CI Recovery/merge train own subsequent
checks and recovery. Diagnostic JSON and screenshots are local under
`tmp/floor4-density/` and `tmp/e2e-screenshots/floor4-density.png`.
