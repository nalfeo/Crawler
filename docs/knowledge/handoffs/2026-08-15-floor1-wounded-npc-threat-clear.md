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

Issue #2969 reported three Floor 1 losses in release sweep run `31872745715` at
commit `69ada7c57bb59d73f7216e2b00f7d535379004a8`. Floor 1 has a 100% success
requirement, so the losses were treated as actionable. The affected release leg
was viewed with `project:sweep-results-viewer runId=31872745715`.

The fix keeps healthy projectile NPC travel behavior intact, but when a
projectile user is wounded below `WOUNDED_PROJECTILE_NPC_THREAT_CLEAR_HP_FRACTION`
(30% HP), the Progress NPC-approach branch no longer skips `ENGAGE` for a nearby
threat. The runner clears the local threat before continuing to the quest NPC.
Melee behavior keeps the existing wounded expansion to the normal engagement
radius.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
  - Split the NPC-approach threat gate into explicit projectile-force-clear and
    melee-radius-expansion decisions.
  - Wounded projectile users now clear nearby NPC-approach threats instead of
    relying on auto-fire while continuing travel.
- `src/game/ai/bt-ai-tuning.ts`
  - Added the 30% wounded projectile NPC threat-clear threshold.
- `tests/game/behavior-tree-ai.test.ts`
  - Added direct unit coverage for the wounded projectile NPC-approach contract,
    alongside existing healthy projectile and melee NPC threat-clear coverage.
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
was also run after the fix; results are recorded in the PR validation summary.

## Key decisions made

- Rejected broad weapon/persona Constitution tuning: it fixed one seed while
  risking unrelated balance drift and regressions.
- Rejected a wider global low-HP retreat radius: it did not recover the losses and
  risked collapsing retreat hysteresis.
- Rejected a boss-entry readiness gate: it caused timeout/farming behavior instead
  of restoring reliable progression.
- Chose the narrow NPC-approach threat-clear branch because the failing projectile
  run walked through nearby threats while trying to reach a quest NPC; the change
  preserves healthy projectile auto-fire travel and existing melee semantics.

## Verification

- `npx vitest run --project headless tests/headless/floor1-legacy-death-regressions.test.ts --reporter=verbose` — passed 13/13 before the final focused unit assertion.
- `npx vitest run tests/game/behavior-tree-ai.test.ts --reporter=verbose --testNamePattern "NPC|wounded projectile|travelling toward an NPC|engages nearby enemies before long NPC"` — passed 16 selected tests.
- `bash scripts/agent/preflight.sh` — passed after dependencies were installed.
- `npm run verify:fast` — passed before final cleanup; rerun after final changes before publication.
- `npm run ai:winrate-sweep -- --floor floor1 --seeds 1-50 --weapons sword,bow,baseball-bat,pistol,throwing-knife,fireball --out /tmp/floor1-release-current.json` — run for exact release-leg evidence.

## Unresolved issues

None known for the targeted Floor 1 release-loss signature. The remaining work at
handoff time is publication ceremony: final ledger validation, PR prereq check,
code review, CodeQL, and progress push.

## Recommended next steps

Publish the ready-for-review PR after final validation. CI should run the full
required gate set.
