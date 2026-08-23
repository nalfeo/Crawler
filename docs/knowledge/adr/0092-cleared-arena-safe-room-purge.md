# ADR-0092: Cleared boss arenas become safe rooms with occupant purge

## Status

Accepted — amends the final decision bullet of
[ADR-0091](0091-floor1-ai-recovery-state-contracts.md)

## Date

2026-08-23

## Estimated Complexity

🍎🍎🍎 — one shared predicate, scenario conversion cleanup, and regression coverage.

## Context

ADR-0091 decided that "safe-space helpers consult the cleared-room set when
resolving retreat/equip anchors." The implementation made
`isPointInSafeSpace` itself return `true` for any room in
`world.clearedSafeRoomIds`.

`isPointInSafeSpace` is not a cosmetic label. It is the engine's
combat-suppression contract, and five independent subsystems key off it:

- the player's weapon is disabled inside it,
- `enemyAISystem` refuses to path or spawn into it,
- `floorScenario` pauses the floor-collapse deadline while the player stands in
  it, and `isOfficialWin` discounts that time from the run clock,
- the behavior tree switches to `buildLeaveSafeRoomBehavior`, and
- the AI's anti-wedge watchdogs (`updateGlobalDwellWatchdog`, the ENGAGE
  no-progress watchdog) deliberately stand down, on the assumption that
  LeaveSafeRoom is already walking the player out.

Floor 1's final boss arena is the room that **owns the staircase**
(`FloorMap.bossStairRoom`), so clearing it declared the floor's exit to be a
place the AI must leave, cannot be watchdogged out of, and whose collapse clock
never advances. The result was a livelock: on
`seed=1 --weapon throwing-knife` the run killed the staircase boss at ~392s and
then vibrated ~20 ft from the staircase — same room, no wall between — until the
quest-stall detector fired with `floor1-leave-floor` incomplete. The release
sweep for `d143f15a` lost four Floor 1 runs this way (issue #3352), against a
hard 100% Floor 1 requirement.

The pause also made the post-boss farm window unclosable:
`resolveFloor1PlanningDeadlineMs` inherits the paused objective deadline 1:1, so
`planningDeadlineMs - elapsedMs` stayed constant forever.

## Decision

- `isPointInSafeSpace` includes authored SAFE rooms, the safe spawn room, and
  boss rooms listed in `world.clearedSafeRoomIds` for the current `FloorMap`.
- The floor scenario keeps boss-room roles intact instead of rewriting them to
  `SAFE`; staircase, minimap, spawn-suppression, and boss-room consumers still
  resolve the authored boss room by role.
- When a boss room is first registered as cleared, any live enemies already
  inside are removed directly, emit burst VFX, and bypass `dropSystem`, so they
  grant no loot, XP, slime splits, or normal kill credit.
- The first conversion that actually purges enemies unlocks the
  `boss-room-sanitized` achievement.
- `isPointInClearedArena` and `world.playerInClearedArena` remain as
  discriminator facts for callers that need to know a safe room came from a
  cleared boss arena.
- `isInSafeContext` — the customization/equip gate — is satisfied by
  `world.playerInSafeRoom` during active gameplay, or by the explicit
  post-floor `safe_room` state. It does not trust stale positional flags after
  gameplay ends.
- `resolvePostBossFarmWindow` measures its reserve against
  `min(planningDeadlineMs, floorBudgetMs)`, so the window is provably bounded in
  `elapsedMs` even while the converted staircase arena pauses the collapse
  deadline.

## Consequences

### Positive

- The "boss room becomes safe room" feature remains intact.
- Converting a room cannot strand enemies inside the new safe zone or reward the
  player with combat drops for enemies they did not fight.
- The post-boss farm window clamp keeps the seed-1 staircase stall bounded even
  though the converted exit arena pauses the collapse deadline.

### Negative

- `GameWorld` still carries two adjacent booleans, and callers must pick the one
  matching their intent (safe-room suppression vs. converted-room identity).

### Risks

- A future direct-removal path could accidentally bypass sidecar bookkeeping.
  The purge helper deletes the current Floor 1/Floor 2 ambient maps and uses
  `clearEntityStores`; tests pin the no-loot/no-XP contract.

## Alternatives Considered

1. **Revert PR #3276 wholesale.** Rejected: four of its five fixes (gold
   reserve, farming knobs, chest death-spot drops, floor-scoped cleared-room
   map) are correct and unrelated to the stall.
2. **Make cleared arenas customization-only, not safe spaces.** Rejected after
   maintainer clarification: the intended feature is that boss rooms become real
   safe rooms after battle.
3. **Exclude only the staircase-owning arena.** Rejected as arbitrary — it would
   disable the feature in the most visible Floor 1 case instead of fixing the
   enemy-occupancy and farm-window edge cases around it.
