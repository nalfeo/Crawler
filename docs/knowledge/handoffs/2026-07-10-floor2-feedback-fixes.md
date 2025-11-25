# Handoff — Floor 2 Feedback Fixes

**Date:** 2026-07-10  
**Branch:** `copilot/floor2-feedback`  
**Estimate:** 2 apples 🍎🍎

## Systems touched

mapgen, quests, hud-ux

## Summary

Three Floor 2 feedback issues addressed:

1. **All Floor 1 systems active on Floor 2 start** — `initializeFloor2Scenario` now sets
   `world.featureUnlocks.{inventory,equipment,spells} = true` and sets the `floor1-drops-unlocked`
   goal flag so the XP bar and all UI panels are visible from the first frame of Floor 2.

2. **Reputation system gated behind Broker intro dialogue** — Added optional `reputationSystemActive`
   field to `Floor2State` (default: `undefined` = active, for backwards compat). Set to `false`
   at floor init; `familyRelationshipSystem` now discards queued deltas and skips when explicitly
   `false`; `floor2ObjectiveTick` flips it to `true` on the same tick
   `FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID` is set (after the player reads all Broker intro lines).

3. **"Thin the ranks" den quests hidden** — Added `hidden?: boolean` to `QuestDef` and the
   Zod quest schema. Den-unlock kill-counter quests are now marked `hidden: true` in
   `buildDenUnlockQuestPack`. `HudQuestTracker` filters hidden quests from the display list.
   `questSystem` auto-tracking prefers non-hidden quests; falls back to hidden only when all
   active quests are hidden.

## Files changed

- `src/core/faction-relations.ts` — `reputationSystemActive?: boolean` added to `Floor2State`
- `src/core/systems/familyRelationshipSystem.ts` — reputation system guard
- `src/core/systems/questSystem.ts` — hidden-quest-aware auto-tracking
- `src/engine/HudQuestTracker.ts` — filter hidden quests from display
- `src/shared/quest-types.ts` — `hidden?: boolean` on `QuestDef` + `QuestPackQuestSource` + schema
- `src/game/floor2Scenario.ts` — feature unlock init, `reputationSystemActive: false`, reputation activation, `hidden: true` on den quests
- `tests/unit/floor2-scenario-initialization.test.ts` — updated + 2 new tests
- `docs/knowledge/adr/0055-floor2-progression-gates.md` — ADR
- `docs/knowledge/review-ledgers/2026-07-10-floor2-feedback-fixes.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-10-floor2-feedback-fixes.json`

## Verification run

- `npm run verify:fast` ✅
- `npx vitest run tests/headless/floor2-completion.test.ts` ✅
- `npx vitest run tests/ecs/familyRelationshipSystem.test.ts tests/integration/family-relationship-wiring.test.ts tests/unit/floor2-scenario-initialization.test.ts` ✅

## Unresolved issues

- The `reputationSystemActive` field uses optional semantics (undefined = active) for backwards
  compatibility with labs. Labs that construct `Floor2State` directly and test reputation flow
  don't need changes. If future code wants to explicitly opt in to reputation-locked behaviour
  outside Floor 2, it can set `reputationSystemActive: false` directly.
- Hidden quests are still returned by `getActiveQuests()`. Code that counts or aggregates active
  quests should filter with `getQuestDef(q.questId)?.hidden` if it needs only visible quests.

## Recommended next steps

- Add more Floor 2 starter quest chain quests (settlement NPC conversations, etc.) gated behind
  the reputation activation — currently the Broker intro completion flag gates reputation.
- Consider whether "thin the ranks" should be surfaced somewhere else (e.g. a passive progress
  tooltip on the den door) so players still get feedback on their kill progress.
