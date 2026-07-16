# Session Handoff: Floor 1 boss-door quest gate + Leave the Floor quest

## Date

2026-06-24

## Persona(s) adopted

Producer — multi-layer task spanning quest data, floor scenario logic, ECS systems, and tests.

## Systems touched

enemies, quests

## Apple estimate / actual

Estimated: 🍎🍎🍎
Actual: 🍎🍎🍎
Verdict: 🎯 Exact

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

### Boss room door now requires all three quests

Previously the boss-stair-room door only checked two goal flags:

- `floor1-shop-quest-complete` (merchant errand)
- `floor1-boss-battle-complete` (spell broker's Slime Rat quest)

The goon's kill-grind (`floor1-goon-quest-complete`) was not part of the gate, contradicting the design intent. Added it as a third condition so the door now opens only when all three quests are complete.

### New final quest: "Leave the Floor"

Added `floor1-leave-floor` quest (given by Tutorial Goon):

- Auto-accepted in `floor1ObjectiveTick` the moment all 3 prerequisite flags are set
- Step 1: Defeat the Floor Boss — `kind: goal`, `goalId: floor1-defeat-boss`
- Step 2: Take the stairs to Floor 2 — `kind: goal`, `goalId: floor1.objective.staircaseDiscovered`
- `onCompleteGoalFlag: floor1-leave-floor-complete`

### `confirmFloor1StairDescend` now calls `questSystem`

`autoFloor1ProgressionSystem` calls `confirmFloor1StairDescend` after `runSimulationStep`
(which runs `questSystem`). The staircase goal flag is set inside `confirmFloor1StairDescend`,
meaning `questSystem` never sees it in the current frame. Added an immediate `questSystem(world)`
call after the flag so the leave-floor quest resolves to `complete` before the headless runner
detects victory and breaks. This pattern matches `startFloor1BossEncounter` which already called
`questSystem` inline.

### Files changed

- `src/shared/data/quests.floor1.json` — added `floor1-leave-floor` quest
- `src/shared/quest-types.ts` — exported `FLOOR1_LEAVE_FLOOR_QUEST_ID`
- `src/game/floor1Scenario.ts` — 3-condition door lock, auto-accept quest, shortcut, questSystem call
- `tests/game/floor1-scenario.test.ts` — boss-door test now verifies all 3 gates
- `tests/headless/floor1-completion.test.ts` — added `FLOOR1_LEAVE_FLOOR_QUEST_ID` to required list

## What's Next

- Consider adding explicit UI/dialogue from the Tutorial Goon when "Leave the Floor" is accepted
  (currently silent auto-accept; no goon dialogue line is triggered)
- The Goon quest chain could be extended to nudge the player toward finding the merchant and spell
  broker (currently those are discovered organically; no quest objective says "find the other NPCs")

## Blockers

None.

## Branch / PR

- Branch: `copilot/ensure-boss-room-requirements`
- PR: #265
- All tests passing: yes (unit 1643, headless 4)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no telemetry section.
