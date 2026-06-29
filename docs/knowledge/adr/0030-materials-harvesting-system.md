# ADR-0030: Materials Harvesting System

## Status

Accepted

## Context

Floor 1 needed a resource-gathering mechanic: the player can collect mushrooms,
flowers, and lichens by standing on them for a set duration. The design required:

- **Finite floor supply** — ≤ 5 of each material type per floor.
- **Timed proximity trigger** — player must stay within range for X seconds.
- **Circular countdown wheel** — world-space progress arc drawn around the node.
- **Inventory delivery** — harvested material added to the player's inventory bag.

## Decision

### Component model

A new `Harvestable` ECS component and `harvestable` typed-array store were added
to `src/core/components.ts`. The store fields are:

| field          | type           | purpose                                              |
| -------------- | -------------- | ---------------------------------------------------- |
| `defIndex`     | `Uint16Array`  | Index into `HARVESTABLE_DEFS` registry.              |
| `durationMs`   | `Float32Array` | Total harvest duration (mirrored from def for perf). |
| `progressMs`   | `Float32Array` | Milliseconds of continuous proximity so far.         |
| `harvesterEid` | `Uint16Array`  | EID of the player entity currently harvesting.       |

### Registry

`src/shared/harvestableDefs.ts` is a stable-index array of `HarvestableDef`
objects. Appending to the end never invalidates existing `defIndex` values (same
pattern as `SPAWNER_ARCHETYPES`).

### Harvest system

`src/core/systems/harvestSystem.ts` is a pure ECS system
`(world: GameWorld) => void`. It:

1. Finds the single `[Player, Position, Inventory]` entity.
2. Queries all `[Harvestable, Position]` nodes.
3. For each node, tests `distSq ≤ HARVEST_RANGE_FT²` (1 ft).
4. In range: increments `progressMs` by `GAME.DELTA_MS`. On completion adds the
   item, removes the entity, emits a `pickupSparkle` VFX event.
5. Out of range: resets `progressMs` and `harvesterEid` to 0 if previously > 0.

### Engine rendering (progress wheel)

`PhaserBridge.ts` detects `entityType === 'harvestable'` and draws with a
per-entity `Phaser.GameObjects.Graphics` object (managed like `beamGraphics` and
`arcGraphics`). Each frame:

1. Node body: filled/stroked circle in the def's `tint` colour.
2. Progress ring (only when `progressMs > 0`): a dark background track circle
   plus a green arc sweeping clockwise from 12 o'clock proportional to
   `progressMs / durationMs`.

### Floor spawning

`spawnFloor1HarvestableNodes()` in `src/game/floorScenario.ts` is called once
at the end of `initializeFloor1Scenario()`, after all rooms are assigned their
roles. It scans NORMAL and SPAWN rooms, uses `world.rng` to pick 2–5 random
passable interior tiles per def, and enforces a 3 ft minimum spacing between
same-type nodes.

## Alternatives Considered

### Collision-based trigger (like itemPickupSystem)

The collision system fires on overlap and immediately collects items. For
harvesting we need a sustained proximity timer, so a separate harvestSystem with
a progress accumulator is the right model.

### Server-tick wall clock instead of fixed `GAME.DELTA_MS`

Using `world.elapsedMs` (elapsed wall time) and storing a `startedAtMs` field
would allow real-time harvest. Rejected because it breaks replay determinism: the
same inputs must always produce the same outputs. `GAME.DELTA_MS` per tick keeps
the system deterministic.

### Separate progress UI component

A dedicated HUD component (like `HudHealthBar`) was considered for the countdown
wheel. Rejected because the wheel is world-space (attached to the node, not the
screen) and managed per-entity, making it a natural fit for the PhaserBridge
per-entity render path — the same pattern used for beam and arc graphics.

## Consequences

- **New systems file** requires a lab (`harvest-lab`) per the lab-gate policy.
- **HARVESTABLE_DEFS is append-only** — reordering breaks any saved state that
  stores defIndex. This is documented in the registry header.
- The `Harvestable` component is currently used only for floor-1 nodes. Future
  floors can add new defs by appending to `HARVESTABLE_DEFS`.
- Progress resets silently on player movement. A future enhancement could add
  partial persistence or a "you started harvesting" VFX cue.
