# Handoff — Floor 2 Family Boss Progression

**Date:** 2026-07-10  
**Branch:** `nalfeo-floor-2-direct-start-flow`  
**Estimate:** 5 apples 🍎🍎🍎🍎🍎

## Systems touched

quests, enemies, boss-rooms, hud-ux, weapons, ai-behavior-tree

## Summary

Completed the expanded Floor 2 family progression contract:

- Thin the Ranks now requires 100 player-attributed non-boss kills per family.
  Damage ownership is preserved through projectile, melee, beam, area, spell,
  death-event, quest-counter, and headless telemetry paths.
- Floor 2 owns durable per-family trash-kill tallies and explicit boss encounter
  records in `floorExtendedState.familyState`.
- Ranged Floor 2 trash and ranged family bosses use the existing deterministic
  ranged AI. Chase bosses retain contact-only attacks.
- Bosses remain inert inside sealed dens until the unlocked den is entered.
  Entry starts permanent aggro, relocks the den doors through goal semantics, and
  displays the shared top-center boss health bar. Boss death marks the encounter
  defeated and reopens the doors.
- Defeated families now display `Defeated` in the reputation HUD.
- The Floor 2 HUD timer resolves the manifest duration and displays 20:00.
- `RunStats.familyTrashKills` reports durable per-family counts on success and
  error paths.
- Resolved spawner arenas now set both `isLocked = 0` and `logicalOpen = 1`,
  preventing the player or headless runner from remaining trapped.

ADR 0057 records the explicit Floor 2 encounter ownership and shared boss-HUD
decision.

## Runtime observation

The real headless Floor 2 pipeline was run with seed 77. It accepted all four
hidden den quests and emitted the new family telemetry contract:

- Geese: 0
- Crabfolk: 0
- Llamas: 0
- Goblins: 4

The runner stalled at 488,083 ms after 360 seconds without quest progress; no den
quest completed. This is honest evidence that the generic BehaviorTreeAI does not
yet execute the authored 100-kill route. The threshold and runtime progression
wiring are correct and deterministic, but a future AI pathfinding/progression
slice must make the headless player deliberately hunt each family. Spawn density
was not changed because this session was explicitly not a rebalance pass.

## Verification

- Targeted Floor 2 unit/integration/ECS/headless tests passed.
- `npm run verify:fast` passed with 1,311 tests.
- Two-round, four-model review completed clean after resolving three valid
  first-round findings.

## Review findings resolved

- Bosses moved and attacked before den-entry activation.
- Chase bosses incorrectly received projectile attack range.
- Resolved spawner-arena doors remained logically closed.

## Remaining gap

The headless BehaviorTreeAI does not currently navigate and farm each Floor 2
family to 100 kills, so it cannot organically produce an end-of-floor screenshot.
The real-game screenshots from the earlier tour prove settlement, boss, victory,
and resource-room rendering, but that tour forced unlock/death state and is not
evidence of organic Thin the Ranks completion.
