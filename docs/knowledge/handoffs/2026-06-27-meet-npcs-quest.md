# Session Handoff: "The Director's Shortlist" — meet-NPCs meta-quest after goon farming

## Date

2026-06-27

## Persona(s) adopted

**Content Designer** — authored floor/quest data and scenario wiring.

## Routing verdict

✅ Right persona — all edits are in `src/shared/data/quests.floor1.json`,
`src/shared/quest-types.ts`, and `src/game/floor1Scenario.ts` (quest content layer,
not engine or core ECS).

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — new quest definition, constant, scenario acceptance hook,
NPC indicator update, and test additions; 4 files, no new ECS system/ADR.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

quests

## What Was Done

After the Tutorial Goon's kill-grind quest (`floor1-boss-unlock`) completes,
the player now receives an explicit quest directing them to find and finish
the Sweaty Merchant's and the Spell Broker's quests — exactly what opens
the final boss door.

### Files changed

1. **`src/shared/data/quests.floor1.json`**
   - Added `floor1-meet-npcs` quest ("The Director's Shortlist") between
     `floor1-boss-unlock` and `floor1-boss-battle`.
   - Two `goal`-kind objectives: `floor1-shop-quest-complete` (merchant errand)
     and `floor1-boss-battle-complete` (spell broker quest).

2. **`src/shared/quest-types.ts`**
   - Exported `FLOOR1_MEET_NPCS_QUEST_ID = 'floor1-meet-npcs'`.

3. **`src/game/floor1Scenario.ts`**
   - Imported `FLOOR1_MEET_NPCS_QUEST_ID`.
   - Added auto-accept logic in `floor1ObjectiveTick`: once `floor1-goon-quest-complete`
     is true, `floor1-meet-npcs` is accepted and tracked — immediately gives the
     player the "two more stops" directive on the quest tracker.
   - Updated `getNpcQuestIndicatorState` for `tutorial-goon` to show `accepted`
     indicator while `floor1-meet-npcs` is active.

4. **`tests/game/floor1-scenario.test.ts`**
   - Added `FLOOR1_MEET_NPCS_QUEST_ID` to imports.
   - Added test: "auto-accepts 'The Director's Shortlist' after the goon kill-grind
     completes" — verifies auto-acceptance on goon flag, not-complete with only one
     NPC quest done, and complete when both NPC quests are done.

### How the boss door still opens

No change to the door-lock conditions. The boss staircase doors unlock when
`floor1-goon-quest-complete + floor1-shop-quest-complete + floor1-boss-battle-complete`
are all true (same as before). The new quest is a quest-tracker affordance only —
it tells the player what to do, and it completes exactly when the two flags that
would unlock the door are set.

## What's Next

- PR ready; arm auto-merge once CI passes.
- Optional: add per-objective unlock sequencing so the tracker only shows the
  merchant objective until it's done, then reveals the Spell Broker objective
  (this is already supported by the multi-step objective hiding logic in
  `getQuestObjectiveViews`, but the quest would need to be authored with
  sequential ordering — currently both goals are revealed simultaneously, which
  is fine for this floor).

## Blockers

None.

## Branch State

- `verify:fast` ✅ — 242 tests pass
- `test:integration` ✅ — 50 tests pass

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present this session — no telemetry section.
