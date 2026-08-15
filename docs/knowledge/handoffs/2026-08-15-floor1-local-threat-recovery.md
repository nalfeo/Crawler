# Session Handoff: Floor 1 Local Threat Recovery

## Date

2026-08-15

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree

## Apples

3🍎 estimated, 3🍎 actual (exact). The final diff stayed surgical: one AI arbitration
guard, one exact headless regression, review ledger, apple record, and this handoff.

## Problem

Release sweep run `31874790650` (`project:sweep-results-viewer runId=31874790650`)
reported a Floor 1 death for:

`floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=34|weapon=baseball-bat`

The local real-headless reproduction matched the artifact:

- outcome `death` at frame 20,049 / 334.2s;
- level 6, 67 kills;
- dominant state `RETREAT`;
- Slime Rat was defeated, but the staircase encounter never started.

## What Was Done

- Fixed `BehaviorTreeAI` retreat arbitration so RETREAT yields only when the current
  threat is the already-armed `LocalThreatRecovery` target on the same floor map
  and the active weapon is melee.
- Kept projectile users on the existing defensive retreat path. An initial broader
  version regressed throwing-knife seed 29; the final melee-only scope passed the
  safety panel.
- Added `tests/headless/floor1-local-threat-recovery-regression.test.ts`, which runs
  baseball-bat seed 34 twice through `runHeadless`, requires an official Floor 1
  victory, verifies a close-call recovery path occurred, and checks deterministic
  paired stats excluding `wallTimeMs`.

## Real-Pipeline Evidence

Observed through the production `BehaviorTreeAI` and `runHeadless` pipeline with
weapon personas enabled and the release 23,760-frame cap:

| Panel                          | Before                                                                | After                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release sweep repro case       | `baseball-bat seed 34` died at 334.2s, level 6, 67 kills, min HP 0.6% | official victory at 298.1s, level 7, 86 kills, min HP 7.1%, final HP 77.1%                                                                                                                                                |
| GitHub broad seed/weapon panel | release sweep incident included this melee death in the issue panel   | GitHub CI run `31886626208` (`Headless Floor 1 Gate` job `95016886447`) passed `tests/headless/floor1-legacy-death-regressions.test.ts` at 10/10 wins (100%) across pistol, throwing-knife, baseball-bat, and sword seeds |
| GitHub seed-panel sanity gate  | failing release sweep showed a non-100% Floor 1 release panel         | the same GitHub job passed `tests/headless/floor1-completion.test.ts` (`win-rate over seeds 1–25`, mixed starter weapons) and `tests/headless/floor1-local-threat-recovery-regression.test.ts` (baseball-bat seed 34)     |

## Review

- Plan review (`gpt-5.4`) approved the root-cause approach and raised one adjacent
  behavior concern: explicitly preserve projectile defensive retreat. Resolved by
  the final melee-only condition and the passing throwing-knife safety case.
- Code review (`claude-sonnet-4.6`) found no significant issues.
- Independent grade (`gemini-3.1-pro-preview`) passed 5/5 on all criteria.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-08-15-floor1-local-threat-recovery.review-ledger.json`.

## Validation

- `bash scripts/agent/preflight.sh`: passed.
- Exact pre-fix repro: reproduced local death for seed 34 / baseball-bat.
- Exact post-fix CLI replay: passed, victory at 298.1s.
- `npx -y node@22 node_modules/vitest/vitest.mjs run tests/headless/floor1-local-threat-recovery-regression.test.ts --project headless --reporter=dot`: passed.
- `npx -y node@22 node_modules/vitest/vitest.mjs run tests/headless/floor1-legacy-death-regressions.test.ts tests/headless/floor1-planning-deadline.test.ts --project headless --reporter=dot`: passed after melee scoping (11/11).
- GitHub broad panel evidence: CI run `31886626208` / job `95016886447` passed the Floor 1 legacy seed/weapon regression panel at 10/10 wins and the seeds 1–25 mixed-weapon completion gate.
- `npm run verify:fast`: passed.
- Review ledger validation: passed.

## Blockers

None known.
