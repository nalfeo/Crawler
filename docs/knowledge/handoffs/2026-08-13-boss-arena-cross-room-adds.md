# Session Handoff: Boss Arena Cross-Room Add Targeting

## Date

2026-08-13

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance, boss-rooms

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Summary

Baseball-bat seed 2's staircase-arena death at release SHA
`30cb03d287de26863f5ca183715ff586f643ba5a` was attributed to a real boss-lock-in
AI defect, not balance variance. During the 1,106-frame encounter, the runner
spent 734 frames trying to clear adds and 369 targeting the boss, but the
selected adds were all in a different semantic room behind the locked arena
boundary. The dominant selected add remained at 25/25 HP across 347 sampled
target frames.

The fix scopes boss lock-in add selection to the boss's semantic room. Generic
targeting and every non-boss caller remain unchanged. No weapon, enemy, health,
damage, spawn, or encounter values changed, and there are no seed- or
weapon-specific branches.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
  - Added optional room scoping to the existing nearest-enemy query.
  - Boss lock-in add selection now supplies the locked boss room ID.
- `tests/unit/ai/bt-arena-lockin-priority.test.ts`
  - Added class-level coverage proving a closer enemy in an adjacent semantic
    room cannot override the boss target.
- `tests/headless/floor1-legacy-death-regressions.test.ts`
  - Added baseball-bat seed 2 to the existing boss lifecycle regression matrix.
- `docs/knowledge/review-ledgers/2026-08-13-boss-arena-cross-room-adds.review-ledger.json`
  - Recorded the completed 3🍎 review harness.
- `docs/knowledge/metrics/apples/2026-08-13-boss-arena-cross-room-adds.json`
  - Recorded exact 3🍎 complexity.

## Real headless evidence

The defect and fix were observed in the real `src/game/ai/headless-runner.ts`
pipeline at the 23,760-frame release budget.

| Case                         |                           Before |                               After |
| ---------------------------- | -------------------------------: | ----------------------------------: |
| baseball-bat seed 2          | death, frame 13,947, 0.6% min HP | victory, frame 14,668, 70.6% min HP |
| Cross-room add target frames |  734 sampled add-clearing frames |                                   0 |
| Boss target frames           |                              369 |                                 697 |

Two repeated post-fix event logs produced the same SHA-256:
`C762BDB8957CE06199AD28490D899E235ECCCBFC63A5456EC6116277F9D20F72`.

The current runner exposes only one decision-mode arm and one pathing-mode arm,
so there was no honest alternate decision-mode policy to compare. Attribution
instead used frame-level decision telemetry, world-room inspection, same-seed
weapon controls, and matched before/after runs.

## No-regression sweep

Matched GitHub sweeps ran seeds 1-10 for sword, bow, and baseball-bat at the
same 23,760-frame budget:

- Control `30cb03d...`, run `31730947008`: sword 10/10, bow 10/10,
  baseball-bat 9/10, total 29/30.
- Treatment `6a48edaa...`, run `31730946668`: sword 10/10, bow 10/10,
  baseball-bat 10/10, total 30/30.

All 29 previously winning weapon/seed pairs remained victories. The only
outcome delta was baseball-bat seed 2, death to victory.

## Verification run

- Focused arena-lock-in unit suite: 12/12 passed.
- Existing real-headless legacy/boss regression suite: 9/9 passed.
- `npm run verify:fast`: passed, including 277 changed tests.
- `npm run check:wired-systems`: passed.
- 3🍎 review ledger: valid; plan review, clean code review, and independent
  grade all complete.
- Independent grade (`gemini-3.1-pro-preview`): pass, 5/5 on all criteria, no
  findings.

## Unresolved issues

None for the current single-room Floor 1 boss arena. A future multi-room boss
arena would need arena-identity or barrier-aware filtering rather than reusing
this room invariant.

## Recommended next steps

Publish the ready-for-review PR and let CI run the full repository suite.
