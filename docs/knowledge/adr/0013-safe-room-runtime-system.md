# ADR-0013: Safe Room Runtime System

## Status

Accepted

**Date:** 2026-06-14  
**Deciders:** Agent session (safe-room-formalization)

## Context

The game design calls for "safe rooms" — spaces (guild halls, shops, personal
rooms) with no hostile mobs, no attacking, no damage. These spaces have two
formal contracts:

1. **Timer pausing.** All floor timers (collapse deadline, stair-unlock
   countdowns, etc.) pause while the player is inside a safe room.
2. **Customization gating.** Equipment, inventory, skill configuration, and
   similar "loadout" systems are only accessible from within a safe room (and
   only if the player has already unlocked them via gameplay).

Prior to this ADR the infrastructure was partial:

- `isEntityInSafeSpace` / `isPointInSafeSpace` in `src/core/safe-space.ts`
  provided geometric detection.
- `world.state === 'safe_room'` gated the equipment system — but that state was
  only set at end-of-run (floor cleared), never during active gameplay.
- The floor-collapse deadline (`objective.deadlineMs`) had no pause mechanism.

## Decision

### `world.playerInSafeRoom: boolean`

A single boolean field added to `GameWorld` (default `false`) that records
whether the player is currently inside a safe room. It is the authoritative
runtime flag for "safe room occupied".

### `safeRoomSystem(world)`

A new ECS system in `src/core/safe-space.ts` that runs each tick (after
`movementSystem` so positions are current). It:

1. Returns immediately when `world.state !== 'playing'` (no-op during loadout,
   pause, game-over, etc.).
2. Queries for the `Player` component to find the player entity.
3. Calls `isEntityInSafeSpace(world, playerEid)` and writes the result to
   `world.playerInSafeRoom`.

### `isInSafeContext(world)`

A helper that returns `true` when customization systems should be accessible:

```ts
world.playerInSafeRoom || world.state === 'safe_room';
```

The two-case design is intentional:

| Case                    | Meaning                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- |
| `playerInSafeRoom`      | In-run safe room: player is physically inside a safe room during active gameplay. |
| `state === 'safe_room'` | End-of-run review: floor cleared, player reviews stats/gear before transitioning. |

Both cases grant access to customization panels.

### Equipment system

`equip()` and `unequip()` in `src/core/systems/equipmentSystem.ts` now check
`isInSafeContext(world)` instead of `world.state === 'safe_room'` directly.
This preserves the end-of-run allowance while also enabling equipment changes
whenever the player is inside a safe room during gameplay.

### Floor collapse timer pausing

`floor1ObjectiveSystem` in `src/game/floorScenario.ts` advances
`objective.deadlineMs` by `GAME.DELTA_MS` each tick when
`world.playerInSafeRoom` is true. Because the deadline is an absolute
elapsed-time threshold, advancing it by the same delta as `world.elapsedMs`
keeps the effective remaining time constant — a simple "clock stop" pattern.

`deadlineMs` is changed from `readonly` to mutable in `Floor1ObjectiveState`.

### UI gating in `MainGameScene`

`[I]` (inventory) and `[G]` (equip) key handlers now require both a feature
unlock (`world.featureUnlocks.*`) **and** `isInSafeContext(world)`. Players
outside safe rooms see their hint toasts but cannot open panels.

### Pipeline ordering

`safeRoomSystem` is called between `fovSystem` and `npcSystem` in
`MainGameScene`'s built-in fixed-timestep loop. This ensures:

- Position is settled (after `movementSystem` and collision).
- `world.playerInSafeRoom` is correct before `postSystems` (including
  `floor1ObjectiveSystem`) run and use it for timer pausing.

## Consequences

### Positive

- Timer pausing is correct-by-construction: any system that reads
  `world.playerInSafeRoom` can add its own pause logic without extra wiring.
- `isInSafeContext` is the single gate for all customization: consistent across
  equipment, inventory, and any future skill/ability panels.
- The end-of-run review flow (`safe_room` state) is unaffected — it still
  grants full customization access.
- Fully testable in isolation (`tests/ecs/safe-room.test.ts`), no Phaser
  dependency required.

### Negative / Risks

- `safeRoomSystem` performs an `isEntityInSafeSpace` tile-bounds check every
  tick. For a single player this is O(n_safe_rooms) and negligible, but floors
  with many safe rooms could accumulate cost. Acceptable for now; a cached
  "dirty position" optimisation can be added if needed.
- `postSystems` injected by labs or tests must be aware that
  `world.playerInSafeRoom` is set by the built-in loop and will not be updated
  if the system is called without `safeRoomSystem` running first. Tests that
  want specific values should set `world.playerInSafeRoom` directly or call
  `safeRoomSystem` themselves.

## Alternatives Considered

1. **`'in_safe_room'` world state.** Would pause the entire simulation loop
   (MainGameScene returns early for non-playing states) — the player could not
   move or interact inside the safe room. Rejected because the game design
   expects full mobility (talking to NPCs, opening loot boxes, etc.) inside
   safe rooms.
2. **Derive `playerInSafeRoom` on demand (no flag).** Each callsite would call
   `isEntityInSafeSpace` directly. Rejected because it scatters the check,
   makes it easy to forget the `state === 'playing'` guard, and runs the
   geometry check multiple times per tick.
3. **Separate timer-pause field on `Floor1ObjectiveState`.** Would require
   per-scenario boilerplate and doesn't generalise. Rejected in favour of the
   `world.playerInSafeRoom` flag that all future scenarios can reuse.
