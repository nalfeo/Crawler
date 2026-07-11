# Handoff — Floor 2 Progression UX Fixes

**Date:** 2026-07-11  
**Branch:** `nalfeo-floor-2-progression-fixes`  
**Estimate:** 4 apples 🍎🍎🍎🍎

## Systems touched

quests, ai-behavior-tree, hud-ux

## Summary

Floor 2 now starts with a production quest waypoint and off-screen arrow to the
settlement. The real behavior-tree/headless runner follows a two-phase critical
chain—settlement discovery, then Broker introduction—before resuming den, boss,
and exit progression. The Families Reputation HUD stays hidden until the Broker
introduction activates the reputation system.

## Root causes and fixes

1. `getQuestWaypoints` returned early whenever the Floor 1 objective snapshot was
   absent. Floor 2 intentionally has no `floorScenario`, so its tracked settlement
   quest could never produce a waypoint.
   - Added a neutral deterministic settlement-anchor resolver based on the
     persisted settlement room id and nearest interior cell.
   - Reused the anchor for Floor 2 settlement waypoints and AI routing.
2. `findFloor2ProgressObjective` only considered den quests, bosses, and exit
   stairs. It ignored the already-authored settlement quest and the distinct
   Broker-introduction phase.
   - Added explicit settlement and Broker phases before existing Floor 2
     progression.
   - Suppressed unrelated opportunistic collect/farm pulls and legacy nearby-threat
     preemption during the introduction chain while retaining retreat and dodge.
   - Invalid or missing Broker entities fall back to the settlement anchor instead
     of silently resuming den/boss progression.
3. `HudFamilyRelationships.sync` showed the panel whenever Floor 2 family state
   existed, ignoring `reputationSystemActive`.
   - Added a pure visibility resolver that hides real Floor 2 state while the flag
     is false and preserves compatibility for older fixtures that omit the field.

## Files changed

- `src/core/floor2-settlement-anchor.ts`
- `src/core/systems/questWaypoints.ts`
- `src/game/ai/bt-ai-provider.ts`
- `src/engine/family-relationships-state.ts`
- `src/engine/HudFamilyRelationships.ts`
- `tests/unit/floor2-scenario-initialization.test.ts`
- `tests/game/behavior-tree-ai.test.ts`
- `tests/headless/floor2-completion.test.ts`
- `tests/unit/hud-family-relationships-state.test.ts`
- `docs/knowledge/adr/2026-07-11-floor2-settlement-progression-contract.md`
- `docs/knowledge/review-ledgers/2026-07-11-floor2-progression-ux-fixes.review-ledger.json`

## Runtime observations

- **Before:** the active/tracked `floor2-find-settlement` quest returned no
  waypoints; the first real AI decision swept family territory for den progress;
  the Families panel appeared immediately at Floor 2 start.
- **After, real game:** `?floor=floor2` visibly showed the active settlement quest,
  a settlement direction arrow labelled `Find the settlement`, and no Families
  panel.
- **After, real headless pipeline:** seed 77 stayed on
  `Heading to the Floor 2 settlement` until discovery, completed the settlement
  quest at 28.6 seconds, then interacted with the Broker. The 2,400-frame run
  reported 99.1% travel efficiency and 0% idle time.
- **After, deterministic state probe:** phase A targeted the shared settlement
  anchor, phase B targeted the live Broker despite nearby enemy/loot pressure, and
  Families visibility changed from false to true only after `meetBroker` plus the
  production Floor 2 objective tick.

Artifacts are under the session folders `floor2-progression-baseline` and
`floor2-progression-postfix`.

## Verification

- Focused Floor 2 regression suite: 91 tests passed.
- `npm run verify:fast` passed after implementation and after review fixes.
- Four-apple adversarial plan review recorded a major design fork to the two-phase
  contract.
- Two-round primary and multi-model code review completed clean after one readonly
  test-fixture fix.
- Review ledger validated.

## Remaining work

- None in this focused scope. Gameplay balance was intentionally unchanged.
