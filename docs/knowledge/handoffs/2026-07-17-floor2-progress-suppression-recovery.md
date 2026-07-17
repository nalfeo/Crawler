# Floor 2 progress suppression recovery

## Date

2026-07-17

## Persona

Systems Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

Estimated: 2 apples

Actual: 2 apples

Verdict: exact. The recovery stayed within one behavior-tree provider and its
existing regression suite.

## Summary

Recovered issue #1236 / draft PR #1239 after its original cloud session died with
only an `Initial plan` commit on the remote branch.

The original seed-42 no-path EXPLORE guard and sealed-wall regression had already
landed on `main` in `87a8a87e` (#1085). A later Floor 2 hunt-progression change
(`81b66eeb`, #1163) added a broad suppression return before hunt target selection.
That prevented the historical fixed-position wall loop, but also hid reachable
entity-based family and boss progress targets during the suppression window.

This recovery keeps the upstream no-path behavior intact and narrows the later
suppression:

- Passes the active `progressSuppressed` state explicitly into
  `findFloor2QuestProgressTarget`.
- Suppresses only fixed-position territory patrol/fallback targets.
- Keeps reachable family enemies, territory enemies, quest-item entities, and
  Floor 2 bosses eligible while fixed progress navigation is suppressed.
- Retains the existing explicit suppression gate for the fixed Floor 2 exit
  staircase.

## Tests

`tests/game/behavior-tree-ai.test.ts` now:

- Reuses a single suppression helper for the established private-state test seam.
- Proves an unlocked Floor 2 boss-den entity target remains available under active
  progress suppression.
- Proves a reachable family enemy remains available through
  `findFloor2QuestProgressTarget` while fixed territory goals are suppressed.
- Continues to cover the upstream sealed-wall no-path target clearing and the
  fixed territory/staircase suppression regressions.

## Observe before done

All observations used the real deterministic Floor 2 pipeline through
`npm run ai:headless -- --seed 42 --weapon sword --floor floor2 --json`.

- Historical broken artifact, exact parent of the upstream fix (`eba8c695`, parent
  of `87a8a87e`): **STALLED** after 439.6s with quest progress frozen for 360s,
  level 5, 58 kills, and repeated drops around the reported wall position near
  `(590, 386)`.
- Untouched PR head before this recovery delta (`f99d8dbd`): **VICTORY**, level 11,
  262 kills, 797.3s.
- After this recovery delta: **VICTORY**, level 11, 262 kills, 797.3s.

The current branch therefore preserves the upstream elimination of the historical
wall-wiggle/stall signature while restoring useful entity progress during fixed-goal
suppression.

## Validation

- `npx vitest run tests/game/behavior-tree-ai.test.ts --reporter=dot`:
  100 tests passed.
- `npm run verify:fast`: 12 files / 194 tests passed, plus typecheck, lint, and
  deterministic size/weight/physics checks.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-17-floor2-territory-wiggle-fix.review-ledger.json`
  (2 apples; no review stages required).

## Branch state

- Branch: `copilot/fix-floor-2-seed-42-issue`
- PR: #1239
- No balance, map, quest threshold, or seed-specific changes.
- No blockers.
