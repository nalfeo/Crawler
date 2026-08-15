# Session Handoff: Floor 1 Wounded NPC Threat Clear

## Date

2026-08-15

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual.

## Summary

Issue #2969 reported three Floor 1 losses in release sweep run `31874790650` at
commit `38c1e873afaa275066894d5ae01abd43c1ecfd43`. Floor 1 has a 100% success
requirement, so the losses were treated as actionable. The affected release leg
was viewed with `project:sweep-results-viewer runId=31874790650`.

The fix keeps healthy projectile NPC travel behavior intact, but when a
projectile user is wounded below the existing `RANGED_DEFENSIVE_HP_FRACTION`
(70% HP), the Progress NPC-approach branch no longer skips `ENGAGE` for a nearby
threat. The runner clears the local threat before continuing to the quest NPC.
Wounded melee users also expand NPC-approach threat clearing from the normal 8 ft
cap to their full engagement radius; this is required for baseball-bat seed 34.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
  - Added explicit projectile-force-clear and wounded-melee radius-expansion
    decisions.
  - Wounded projectile users now clear nearby NPC-approach threats instead of
    relying on auto-fire while continuing travel.
- `tests/game/behavior-tree-ai.test.ts`
  - Added direct unit coverage for the wounded projectile NPC-approach contract,
    plus healthy/wounded melee coverage beyond the old 8 ft boundary.
- `tests/headless/floor1-legacy-death-regressions.test.ts`
  - Added deterministic real-headless regression cases for bow seed 35,
    baseball-bat seed 34, and throwing-knife seed 44.
- `docs/knowledge/review-ledgers/2026-08-15-floor1-wounded-npc-threat-clear.review-ledger.json`
  - Records the 3🍎 review harness.

## Real-pipeline evidence

Observed through the real `src/game/ai/headless-runner.ts` pipeline at the
23,760-frame Floor 1 sweep budget.

| Case                   | Before                                      | After                           |
| ---------------------- | ------------------------------------------- | ------------------------------- |
| bow seed 35            | death in the release artifact               | victory, 344.3s, final HP 53.4% |
| baseball-bat seed 34   | death in the release artifact               | victory, 284.1s, final HP 96.3% |
| throwing-knife seed 44 | death at frame ~15,006, 250.1s, min HP 1.8% | victory, 245.3s, final HP 6.2%  |

The local exact Floor 1 release-leg sweep (50 seeds × 6 forced weapons, 300 runs)
finished at **300/300 victories (100%)**, with every weapon at 50/50 and no
failures. The JSON evidence SHA-256 is
`11c0c6928fb78cf2236a4f1dcdaedfc1f1d84d4f428304bc3bcf4c1ec6cee0ed`.

## Key decisions made

- Rejected broad weapon/persona Constitution tuning: it fixed one seed while
  risking unrelated balance drift and regressions.
- Rejected a wider global low-HP retreat radius: it did not recover the losses and
  risked collapsing retreat hysteresis.
- Rejected a boss-entry readiness gate: it caused timeout/farming behavior instead
  of restoring reliable progression.
- Chose the narrow NPC-approach threat-clear branch because the failing projectile
  run walked through nearby threats while trying to reach a quest NPC; the change
  preserves healthy projectile auto-fire travel while expanding wounded melee
  threat clearing only when HP is below the existing farming threshold.

## Verification

- `npx vitest run --project headless tests/headless/floor1-legacy-death-regressions.test.ts --reporter=verbose` — passed 13/13 before the final focused unit assertion.
- `npx vitest run tests/game/behavior-tree-ai.test.ts --reporter=verbose --testNamePattern "NPC|wounded projectile|travelling toward an NPC|engages nearby enemies before long NPC"` — passed 16 selected tests.
- `npx vitest run tests/game/behavior-tree-ai.test.ts --reporter=verbose --testNamePattern "engages nearby enemies before long NPC|expanded melee NPC threat radius|keeps .* travelling toward an NPC|clears nearby NPC-approach threats for wounded projectile"` — passed 8/8 after review recovery.
- `npx vitest run --project headless tests/headless/floor1-legacy-death-regressions.test.ts --reporter=verbose --testNamePattern "baseball-bat seed 34"` — passed after confirming that restoring the old 8 ft cap deterministically reintroduced the death.
- `bash scripts/agent/preflight.sh` — passed after dependencies were installed.
- `npm run verify:fast` — passed before final cleanup; rerun after final changes before publication.
- `npm run ai:winrate-sweep -- --floor floor1 --seeds 1-50 --weapons sword,bow,baseball-bat,pistol,throwing-knife,fireball --out /tmp/floor1-release-current.json` — passed 300/300 with no failures.

## Unresolved issues

None known for the targeted Floor 1 release-loss signature. The remaining work at
handoff time is publication ceremony: final ledger validation, PR prereq check,
code review, CodeQL, and progress push.

## Recommended next steps

Publish the ready-for-review PR after final validation. CI should run the full
required gate set.
