# Floor 1 NPC objective anchors + critical NPC routability

**Date:** 2026-07-11  
**Branch:** nalfeo-fix-floor1-npc-objective-anchors  
**Apple estimate:** 4🍎  
**Verdict:** RECOMMENDED — root-cause fix landed for Shopkeeper/Spell Broker objective-anchor interaction stalls, with placement-level routability hardening for progression-critical NPCs.

## Systems touched

ai-behavior-tree, ai-pathfinding, inventory

## Problem

Floor-1 progression could stall on layout-dependent NPC interactions:

- Shopkeeper/Broker objective branches used raw room-position targets instead of the reachable NPC-anchor path.
- EXPLORE-state NPC interaction permission was effectively tutorial-specific.
- Important progression NPC placement could drift to non-routable or far-away fallbacks when authored stamp tiles were invalid.

This caused deterministic stalls on required repros (`seed21+sword`, `seed30+sword`, `seed30+fireball`).

## What changed

### AI objective + interaction intent generalization

- Added structured NPC interaction intent to AI decisions (`AIDecision.npcInteraction`) and removed reason-string coupling.
- Routed Shopkeeper/Spell Broker interaction-style objectives through reachable-NPC-target creation (`createNpcProgressTarget`) instead of raw room-center progress targets.
- Generalized EXPLORE interaction gating in `autoNpcInteractionSystem` to explicit targeted intent + bounded interaction radius.

### Placement-level routability hardening for critical NPCs

In `src/game/floorScenario.ts`:

- Added deterministic spawn-reachability mask from player spawn over passable+door topology.
- Added routable critical-NPC spawn resolver (`resolveRoutableNpcSpawnPosition`) that:
  - prefers free reachable tiles in the target room,
  - then preferred tile if reachable,
  - then nearest reachable tile globally (deterministic tie-breaking).
- Applied this routability path to progression-critical NPCs (`tutorial-goon`, `shopkeeper`, `spell-quest-giver`).
- Preserved stamped NPC visual overrides (sprite/size/flip/rotation/z) when spawning through placement resolution.

## Validation

- `npm run test:unit -- tests/game/floor1-scenario.test.ts` ✅
- `npm run test:headless -- tests/headless/floor1-npc-objective-anchor-regression.test.ts` ✅
  - `seed21+sword` accepts `floor1-shopkeeper-errand` and clears within official budget
  - `seed30+sword` accepts `floor1-boss-battle` and clears within official budget
  - `seed30+fireball` accepts `floor1-boss-battle` and clears within official budget
- `npm run verify:fast` ✅

## Review harness

- Ledger: `docs/knowledge/review-ledgers/2026-07-11-floor1-npc-objective-anchors.review-ledger.json`
- `plan_review`: completed (adversarial, 3 alternatives)
- `code_review`: completed clean
- `multi_model_review`: completed clean after fix round
- `npm run review:ledger -- validate ...` ✅

## Next step

Rerun the six-shard 600-run GitHub sweep to refresh frontier metrics after this progression-anchor/routability fix lands.
