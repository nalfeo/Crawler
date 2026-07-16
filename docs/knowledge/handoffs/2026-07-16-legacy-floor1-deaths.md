# Session Handoff: Legacy Floor 1 Death Fixes

## Date

2026-07-16

## Persona

Producer -> Game Designer -> QA Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance, boss-rooms, ci-policy

## Apples

4🍎 estimated, 4🍎 actual

## What Was Done

- Investigated all seven deaths from Weapon Sweep run `29453994290` and reproduced
  the exact `(weapon, seed)` cases with forced weapons in `legacy/legacy` mode.
- Preserved the healthy 6-ft projectile orbit while adding a wounded projectile
  contact-pressure retreat. It starts only inside 4.5 ft, releases at 15 ft, and
  hands control back to combat instead of inheriting the 30-ft critical-health
  retreat latch.
- Added a latched wounded projectile spacing ring capped at 10 ft. Its wider
  pressure-release radius prevents 6-ft/15-ft oscillation without restoring the
  long-range projectile misses that previously caused tutorial stalls.
- Updated wounded boss lock-in targeting to clear the nearest non-boss add inside
  the 9-ft pressure radius, including exact boss/add distance ties. Healthy players
  retain boss focus.
- Cleared both new combat latches on hostile-encounter invalidation and provider
  reset so reused AI instances do not leak defensive state into a new encounter.
- Added focused behavior-tree and lock-in unit coverage plus a deterministic
  real-headless regression covering all seven authoritative deaths.
- Completed the required adversarial plan review, bounded code-review loop, and
  multi-model review with adjudication. Review fixes covered encounter-reset latch
  leakage and exact boss/add tie selection.

## Key Decisions

- Fix decision policy rather than weapon, enemy, damage, health, or encounter
  balance.
- Keep all behavior shared and mode-invariant; no seed IDs, weapon IDs, or
  legacy-only branches were introduced.
- Use emergency retreat only to escape immediate contact. A longer retreat turned
  one death into 222 seconds of fleeing and a timeout, so the new mode has its own
  bounded release distance.
- Do not add speculative boss-entry readiness logic. Tactical spacing, retreat, and
  add-priority changes alone satisfied the 7/7 hard gate.
- Keep the accepted exact-case gate separate from a future broad cloud sweep. The
  latter is useful aggregate confirmation but was not required to prove this slice.

## Real Headless Observation

The real `src/game/ai/headless-runner.ts` pipeline was run with explicit
`--pathing-mode legacy --decision-mode legacy --max-frames 23760`; every run printed
the expected seed and forced starting weapon.

| Weapon         | Seed | Before | After frames | Minimum HP |
| -------------- | ---: | ------ | -----------: | ---------: |
| baseball-bat   |   25 | death  |       12,120 |      36.7% |
| pistol         |   30 | death  |       13,800 |      40.0% |
| sword          |   44 | death  |       15,323 |      35.0% |
| throwing-knife |    2 | death  |       23,246 |      55.8% |
| throwing-knife |    6 | death  |       17,332 |      56.7% |
| throwing-knife |   81 | death  |       16,511 |      48.3% |
| throwing-knife |   84 | death  |       12,485 |      56.7% |

All seven after-runs ended in official victory under the authoritative 23,760-frame
budget.

## Validation

- `npm run verify:fast` -> pass (250 tests)
- `npx -y node@22 node_modules/vitest/vitest.mjs run tests/headless/floor1-legacy-death-regressions.test.ts --project headless --reporter=dot`
  -> 7/7 pass
- Exact direct CLI replay panel -> 7/7 victories
- Review ledger validation -> valid 4-apple ledger

## What's Next / Blockers

- No implementation blocker remains.
- A future GitHub-backed six-weapon sweep can measure aggregate movement after merge;
  broad sweeps remain cloud-only by default.
