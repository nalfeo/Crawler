# ADR-0092: A cleared boss arena is a customization space, not a safe space

## Status

Accepted — amends the final decision bullet of [ADR-0091](0091-floor1-ai-recovery-state-contracts.md)

## Date

2026-08-23

## Estimated Complexity

🍎🍎🍎 — one shared predicate, one new world flag, and the AI/scenario consumers that read them.

## Context

ADR-0091 decided that "safe-space helpers consult the cleared-room set when
resolving retreat/equip anchors." The implementation went further than the
decision: `isPointInSafeSpace` itself started returning `true` for any room in
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
place the AI must leave, must not fight in, cannot be watchdogged out of, and
whose collapse clock never advances. The result was a livelock: on
`seed=1 --weapon throwing-knife` the run killed the staircase boss at ~392s and
then vibrated ~20 ft from the staircase — same room, no wall between — until the
quest-stall detector fired with `floor1-leave-floor` incomplete. The release
sweep for `d143f15a` lost four Floor 1 runs this way (issue #3352), against a
hard 100% Floor 1 requirement.

The pause also made the post-boss farm window unclosable:
`resolveFloor1PlanningDeadlineMs` inherits the paused objective deadline 1:1, so
`planningDeadlineMs - elapsedMs` stayed constant forever.

## Decision

- `isPointInSafeSpace` means **authored SAFE rooms and the safe spawn room, and
  nothing else**. It never consults the cleared-room set.
- The cleared-arena concept gets its own predicate, `isPointInClearedArena`, and
  its own world flag, `world.playerInClearedArena`, maintained by
  `safeRoomSystem` alongside `playerInSafeRoom`.
- `isInSafeContext` — the customization/equip gate — is satisfied by a safe
  room, the end-of-run `safe_room` state, **or** a cleared arena. This is what
  ADR-0091 actually asked for: the Commercial Break beat still opens the
  equipment panels where the boss died.
- `resolveNearestSafeAnchor` keeps its cleared-arena retreat branch, so a cleared
  arena remains a routable retreat destination.
- `resolvePostBossFarmWindow` measures its reserve against
  `min(planningDeadlineMs, floorBudgetMs)`, so the window is provably bounded in
  `elapsedMs` even if some future change re-inflates a deadline.

## Consequences

### Positive

- Floor 1's exit arena is ordinary ground again: weapon live, enemies allowed,
  collapse clock running, watchdogs armed. The seed-1 stall cannot recur.
- The run clock can no longer be inflated by parking in a cleared arena, which
  closes a scoring hole in `isOfficialWin`.
- ADR-0091's two stated cleared-arena affordances — retreat routing and
  equip/customization — are both preserved.

### Negative

- `GameWorld` now carries two adjacent booleans, and callers must pick the one
  matching their intent (suppression vs. customization).

### Risks

- A future consumer may reach for `isPointInSafeSpace` when it means "the player
  can safely stop here." The doc comments on both predicates name the split
  explicitly, and `tests/ecs/safe-room.test.ts` pins the contract from both
  sides.

## Alternatives Considered

1. **Revert PR #3276 wholesale.** Rejected: four of its five fixes (gold
   reserve, farming knobs, chest death-spot drops, floor-scoped cleared-room
   map) are correct and unrelated to the stall.
2. **Keep the arena fully safe and patch the AI.** Rejected: it needs
   LeaveSafeRoom suppression _plus_ watchdog re-enablement _plus_ a farm-window
   rework, and still leaves the player weaponless at the exit with an unbounded
   collapse clock.
3. **Exclude only the staircase-owning arena.** Rejected as arbitrary — the
   overreach is in the predicate's meaning, not in one room's identity, and the
   same trap would fire on any future floor whose exit sits in a boss room.
