# ADR 0050: Dynamic Barrier Primitive

## Status

Accepted

## Date

2026-07-04

## Estimated Complexity

🍎 x 3 — new core primitive (registry + geometry + physics + renderer), replaces a live subsystem (`raiseFence` / `lowerFence` tile-flag snapshot), touches movement, pathfinding, LOS, and the spawner arena system.

## Context

PR #764 ("Spawner Battle Arena") shipped a `raiseFence` / `lowerFence` helper pair in `src/game/spawners/spawnerArenaSystem.ts` that mutated `TileMap.flags` on the ring of tiles at `radius ± halfTile` around a spawner, using a byte-exact snapshot into `world.spawnerArenaFence` for restore on resolve. The user's original requirement was explicit:

> If not a sealable room, a circular, **impenetrable** fence appears around the spawner. Blocks movement + projectiles, damage-immune.

The implementation only touched **currently-passable** tiles at trigger time. Any tile whose byte was already non-passable (wall, out-of-bounds) was skipped so the restore step would not corrupt the map. On natural Floor-1 runs the ring often lands on a mix of floor and wall tiles — the snapshot would then include only the passable slice of the ring, and the reported "cage" had gaps wherever the ring crossed a wall. The player could **walk through** the wall+ring seam because the wall itself was already blocking on one side but the ring never got promoted to non-passable on the other side (there was no ring tile there to promote). The PR was self-reported as "caveat: sparse rings leak" instead of being fixed.

That was a rule-12 miss. The spec says impenetrable. Impenetrable is not "impenetrable on the tiles that happened to be floor when we looked".

Two design forces:

1. **Passability-agnostic ring.** Whether a ring tile is under a wall, floor, or corridor at trigger time must not matter for cage integrity. A ring landing entirely on walls should still form a closed cage — the barrier is a **separate overlay** that is impenetrable in its own right, so double-covering walls is a no-op and half-covering the seam is impossible.
2. **General primitive.** Fences, doorway plugs, boss-room arenas, and future scripted encounters all want the same shape: "an ephemeral, impenetrable set of tiles that blocks movement + projectiles, lets FOV through, and is damage-immune." Baking this into `spawnerArenaSystem` is an obvious future-tax on other systems.

## Decision

Introduce a **first-class barrier primitive** at `src/core/barriers/` and refactor the spawner arena to consume it. Physics blockers (movement, projectile, pathfinder) consult a single helper — the barrier is not a `TileMap.flags` mutation and does not touch tile bytes at all.

### Registry, not per-entity component

Two shapes were on the table:

- **A**: A per-barrier ECS entity carrying a `Barrier` component with a tile list, and a system that rebuilds a global "blocked tiles" set each tick.
- **B**: A world-level `BarrierRegistry` (Map<id → handle> + `blockedTiles: Set<number>` union) mutated only when barriers are created/dropped, plus a monotonically-bumped `version` counter for renderers/pathfinders to notice invalidation.

We chose **B** for four reasons:

1. **Zero per-tick cost.** Physics reads a `Set<number>.has(idx)` on the movement critical path; the union is maintained on mutate, not per tick.
2. **Deterministic ids independent of ECS entity recycling.** Barriers rendezvous between systems via `BarrierHandle.id`, not via an ECS id that may be reused.
3. **Overlap-safe drop.** When two barriers share a tile (e.g. two overlapping ring barriers), dropping one must NOT unblock the shared tile. The registry rebuilds `blockedTiles` from remaining barriers on drop — a per-entity system would need to route the same logic anyway. Keeping it inside the primitive means callers can't get this wrong.
4. **Renderer invalidation is trivial.** `world.barriers.version` bumps on every mutate; the engine renderer subscribes to the version and rebuilds its sprite batch only when it changes.

### Public API

```ts
// src/core/barriers/index.ts
export type BarrierKind = 'fence' | 'forcefield' | 'wall';

export interface BarrierHandle {
  readonly id: number;
  readonly kind: BarrierKind;
  readonly tiles: readonly number[];
}

export interface BarrierRegistry {
  readonly barriers: Map<number, BarrierHandle>;
  readonly blockedTiles: Set<number>;
  version: number;
}

export function createBarrierRegistry(): BarrierRegistry;
export function createRingBarrier(world, cxFt, cyFt, radiusFt, kind): BarrierHandle;
export function createRoomBarrier(
  world,
  roomId,
  kind,
  options?: { doorwaysOnly?: boolean },
): BarrierHandle;
export function createPolyBarrier(world, tiles, kind): BarrierHandle;
export function dropBarrier(world, handle | id): void;
export function isBarrierTile(world, tileIdx): boolean;
export function isBarrierAt(world, xFt, yFt): boolean;
export function attachBarriersToFloorMap(world): void;
```

`attachBarriersToFloorMap` installs a lookup closure on the FloorMap so `FloorMap.isPassableAt(x, y)` can consult the barrier registry without needing a `world` reference. Both floor scenarios (`floorScenario.ts` and `floor2Scenario.ts`) call this after assigning `world.floorMap`.

### Geometry

- `collectRingTiles(cxFt, cyFt, radiusFt, tileSizeFt)` — enumerates every tile whose center falls in the annular band `(r - halfTile, r + halfTile]` around the center. **Skips door tiles** (they have their own lock semantics) but **includes wall tiles** — double-covering walls is safe and eliminates the seam-leak class the old snapshot approach couldn't handle.
- `collectRoomDoorwayTiles(roomGraph, roomId)` — enumerates every door tile of the given room. Used for the belt-and-suspenders doorway barrier on sealed-room arenas.
- `collectRoomInteriorTiles(roomGraph, roomId)` — reserved for future room-interior barriers.

### Physics integration surface

- **Movement.** `FloorMap.isPassableAt(xFt, yFt)` was extended with a `barrierLookup` closure: if it returns `true`, the tile is non-passable regardless of underlying flags. `movementSystem` already consults `isPassableAt` on both the composed and per-axis slide paths, so the barrier is honored automatically.
- **Pathfinding.** `isTileTraversable(world, tileX, tileY, mode)` in `src/core/map/pathfinding.ts` returns `false` when `world.barriers.blockedTiles.has(idx)` — for BOTH `ground` and `flying` modes. Flying entities cannot bypass barriers.
- **Projectiles.** Projectile systems that already consult `isPassableAt` per step (see `weaponSystem`, `beamSystem`, projectile advancement) inherit the block for free — the barrier presents as "this tile is impassable" and the projectile's per-tile hit rule handles the rest.
- **Damage immunity.** Barriers are not ECS entities and have no `Health` component. `applyDamage` never targets a barrier tile. No changes to the damage path.
- **LOS / FOV.** Barriers are **transparent to light**. The FOV system reads `TileMap.isTransparent(tx, ty)` — which does NOT consult the barrier registry — so FOV rays pass through barriers unchanged. This matches the original "shimmering fence" intent.

### Rendering

`src/engine/BarrierOverlay.ts` is a per-frame layer. On `update()` it compares `world.barriers.version` against its cached version and, when it changed, rebuilds the barrier visuals: a kind-tinted Phaser `Rectangle` per barrier _tile_ (fence green, forcefield blue, wall tan), plus a smooth procedurally-stroked circle for each analytic ring-WALL `shape` (the open-fence cage — no blocky tiles). Depth `BARRIER_OVERLAY_DEPTH = -18` sits above terrain (-20) and above doors (-19), so a sealed-room doorway plug reads as an energy seal _over_ the closed door, while staying well below entities. The overlay **deliberately draws primitives (rectangles + stroked circles), not a tile sprite**: the barrier must render in tests / headless / early-boot scenes where the Kenney atlas isn't loaded, so it never couples to the terrain spritesheet. It hooks into `MainGameScene` alongside the other overlay batches. Because barriers are a data primitive rather than a system, the renderer only needs to subscribe to the registry — there is no per-frame system tick to schedule.

### Spawner arena refactor

`spawnerArenaSystem.ts` now consumes the primitive:

- **Open-fence arena** — `createRingBarrier(world, sx, sy, radiusFt, 'fence')` at arm; `dropBarrier` at resolve.
- **Sealed-room arena** — the existing door-lock config is **kept**, AND we ADDITIONALLY raise `createRoomBarrier(world, roomId, 'fence', { doorwaysOnly: true })` at arm. Belt-and-suspenders: even if a door-lock config bug lets a doorway open, the barrier tile plugs it. Both are dropped on resolve.

Deleted from the old fence path: `raiseFence`, `lowerFence`, `FENCE_TILE_FLAGS`, `collectFenceRingTiles`, `assertFenceBlocks`, and the `spawnerArenaFence` snapshot map on `GameWorld`. The world instead carries a `spawnerArenaBarriers: Map<number, BarrierHandle>` mapping spawner eid → active barrier handle so the resolve path can find its own barrier to drop.

## Consequences

### Positive

- **The fence caveat is gone.** Rings landing on walls form closed cages; rings landing on floor-only or mixed tiles form closed cages; there is no seam-leak class remaining. Asserted end-to-end on a real Floor-1 headless boot across seeds 1–8 in `tests/headless/spawner-arena-caging-natural.test.ts`.
- **Reusable.** Any future system (boss rooms, quest triggers, script actions) can call `createRingBarrier` / `createRoomBarrier` / `createPolyBarrier` / `dropBarrier` without touching `spawnerArenaSystem`.
- **No per-tick cost.** Physics reads a hash-set membership check on the movement hot path; the union is maintained only on mutate.
- **Non-destructive.** Barriers are an overlay — no tile bytes are mutated, no restore step is needed, and a mid-arena scene reload leaves the underlying map untouched.
- **Transparent to LOS.** FOV rays still pass through, preserving the "shimmering barrier" feel from the original spec.

### Negative / trade-offs

- **Two sources of truth for passability.** `TileMap.flags` says one thing; `world.barriers.blockedTiles` says another. Callers must go through `FloorMap.isPassableAt` (or `isTileTraversable` in pathfinding) rather than reading `tileMap.flags` directly. Grep coverage confirms all movement/pathfinding paths use the helpers — but any new physics code MUST use the helpers, not the raw flags.
- **Overlap-aware drop.** `dropBarrier` rebuilds `blockedTiles` from the remaining barriers. This is `O(sum of remaining tile counts)`. For small numbers of active barriers (typical: 0–3) this is fine; a pathological case with hundreds of concurrent barriers would want a per-tile refcount map.

### Neutral

- Renderer is engine-side, not `src/game` — it consumes the primitive rather than being consumed by a system.
- Barrier lab (`src/labs/barrier-lab/`) exercises the primitive independently of spawner arenas; it renders active barriers via the primitive's registry directly and does not depend on the engine overlay.

## Alternatives considered

- **Per-entity `Barrier` component.** Rejected: physics would need a per-tick "rebuild global blocked set" system, id-reuse hazards, and the fact that a barrier is a **volumetric set of tiles** rather than a **spatial entity** made the ECS shape awkward.
- **Reuse tile flags with a `BARRIER` bit.** Rejected: still requires the snapshot/restore dance for the underlying flag, still couples the fence to the tile map, and gains nothing over the overlay.
- **Barrier-as-physics-entity.** Rejected: barriers block many tiles at once, and expressing that as a `BoxCollider` chain is O(tile) collider allocations per barrier for zero physics benefit over a set-membership check.

## Migration notes

- Callers that previously read `world.spawnerArenaFence` should look at `world.spawnerArenaBarriers.get(eid)` instead — the value is a `BarrierHandle`, not a flag snapshot.
- Any new physics code MUST go through `FloorMap.isPassableAt` or `isTileTraversable`, not `TileMap.flags` directly.

## References

- `src/core/barriers/{types,geometry,registry,index,wiring}.ts`
- `src/game/spawners/spawnerArenaSystem.ts` (refactored consumer)
- `src/engine/BarrierOverlay.ts` (renderer)
- `src/labs/barrier-lab/` (playground)
- `tests/unit/barriers/{registry,physics}.test.ts`
- `tests/integration/spawner-arena-caging.integration.test.ts`
- `tests/headless/spawner-arena-caging-natural.test.ts`
- ADR 0044 (Spawner Battle Arena) — superseded fence path
