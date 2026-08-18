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

Wounded-projectile NPC-approach threat clearing (skip `ENGAGE` only while
healthy, gated on the existing `RANGED_DEFENSIVE_HP_FRACTION` 70% HP threshold)
was already merged to `main` via #2971 and is **inherited unchanged** by this
branch — it is not a new behavior introduced here. This PR's only functional
change is the wounded-melee case: it hoists the `weapon`/`projectileWeapon`
lookup earlier in the Progress branch (so the new melee decision can see the
weapon type before the threat radius is computed) and expands NPC-approach
threat clearing for wounded melee users from the normal 8 ft cap to their full
engagement radius; this is required for baseball-bat seed 34.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
  - Hoisted the existing projectile/wounded-projectile lookup earlier in the
    Progress NPC-approach branch (no behavior change — inherited from #2971).
  - Added the new wounded-melee radius-expansion decision
    (`shouldExpandMeleeThreatClear`) required for baseball-bat seed 34.
- `tests/game/behavior-tree-ai.test.ts`
  - Added a focused 8–22 ft boundary `it.each` case for wounded vs. healthy
    baseball-bat NPC-approach threat clearing (verifies the new melee
    expansion specifically; reverting the expansion hunk fails this test).
  - Extended the wounded-projectile NPC-approach assertion to throwing-knife;
    this exercises the inherited #2971 behavior end-to-end but does not itself
    depend on this diff's code change.
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
was re-run in full against the final head (`32b3c3b6f27fea397fe92165b5199eaaafa3a262`)
with:

```
npm run ai:winrate-sweep -- --floor floor1 --seeds 1-50 --weapons sword,bow,baseball-bat,pistol,throwing-knife,fireball --out /tmp/floor1-release-current.json
```

Actual aggregate: **300/300 official wins, 0 true losses (100%)** — every
weapon at 50/50 wins, with 1 slow victory (bow seed 35, over the active-time
budget but still a win, not a failure) and 0 failures/losses of any kind. Full
per-weapon breakdown: sword 50/50, bow 50/50 (1 slow), baseball-bat 50/50,
pistol 50/50, throwing-knife 50/50, fireball 50/50. The JSON evidence SHA-256
is `4e072c18dcf96d8631d5af79da2f5b2211a56a04be103d1d65ad05c1e26d02b6`
(`totalWins:300, totalSlowVictories:1, totalTrueLosses:0, totalRuns:300,
winRate:1`).

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
- `npm run ai:winrate-sweep -- --floor floor1 --seeds 1-50 --weapons sword,bow,baseball-bat,pistol,throwing-knife,fireball --out /tmp/floor1-release-current.json` — re-run against final head `32b3c3b6f27fea397fe92165b5199eaaafa3a262` during CI recovery: 300/300 official wins, 0 true losses, 1 slow victory (bow seed 35), 0 failures. See the real aggregate above.
- Independent grade re-run against final head `32b3c3b6f27fea397fe92165b5199eaaafa3a262` by an uninvolved model during CI recovery — `pass` (correctness 5, scope_discipline 5, test_coverage 5, policy_compliance 5, maintainability 4; 1 minor doc-accuracy finding, resolved above). See `docs/knowledge/review-ledgers/2026-08-15-floor1-wounded-npc-threat-clear.review-ledger.json`.

## Unresolved issues

None known for the targeted Floor 1 release-loss signature. The remaining work at
handoff time is publication ceremony: final ledger validation, PR prereq check,
code review, CodeQL, and progress push.

## Recommended next steps

Publish the ready-for-review PR after final validation. CI should run the full
required gate set.
