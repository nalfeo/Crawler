# Handoff: Dynamic barrier primitive (PR #764 rule-12 fix)

Date: 2026-07-04
Branch: `feat/dynamic-barriers` (stacked on `feat/spawner-battle-arena`).

## Summary

PR #764 shipped a `raiseFence` / `lowerFence` helper pair in
`src/game/spawners/spawnerArenaSystem.ts` that mutated `TileMap.flags` on
the ring of currently-passable tiles at `radius ± halfTile` around a
spawner. Rings crossing walls leaked at the seam (only passable tiles
were promoted; walls stayed on the wall side and the barrier side went
unpromoted where the ring crossed them). Rule 12 forbids soft caveats
— that was a miss.

This session replaces the tile-flag snapshot with a first-class
**dynamic barrier primitive** at `src/core/barriers/`. The primitive is
a passability-agnostic overlay: barrier tiles are tracked in
`world.barriers.blockedTiles` (a `Set<number>`) rather than by mutating
tile flags, so a ring landing on walls, floor, or corridors always
forms a closed cage. `spawnerArenaSystem` is refactored to consume the
primitive; the sealed-room path additionally raises a doorway barrier
alongside the existing door-lock config for belt-and-suspenders
redundancy. See ADR 0050 for the design rationale.

## Files touched

### New

- `src/core/barriers/{types,geometry,registry,index,wiring}.ts` —
  primitive (registry + ring/room/poly constructors + drop + LUT
  attach).
- `src/engine/BarrierOverlay.ts` — engine-side per-frame renderer.
  Subscribes to `world.barriers.version` and rebuilds a
  kind-tinted rectangle batch when the version changes. Depth
  `BARRIER_OVERLAY_DEPTH = -18` (above terrain, below doors).
- `src/labs/barrier-lab/index.ts` — interactive playground (ring /
  doorway / poly barriers, "Drop all", poly-draft click-to-select).
  Registered in `src/lab-main.ts`.
- `docs/knowledge/adr/0050-dynamic-barrier-primitive.md` — ADR.
- `docs/knowledge/review-ledgers/2026-07-04-dynamic-barrier-primitive.review-ledger.json` — 3🍎 ledger with plan_review + code_review, both clean.
- `tests/unit/barriers/registry.test.ts` — 14 tests (lifecycle,
  overlap-safe drop, ring geometry passability-agnostic, doorwaysOnly
  room barrier, version bumping).
- `tests/unit/barriers/physics.test.ts` — 5 tests (movement, ground
  A*, flying A*, LOS transparency).
- `tests/integration/spawner-arena-caging.integration.test.ts` —
  synthetic 40×40 map; drives movementSystem at 1 ft/tick outward;
  asserts containment then release.
- `tests/headless/spawner-arena-caging-natural.test.ts` — natural
  Floor-1 boot, seeds 1..8 via `describe.each`; drives real
  `runSimulationStep` pipeline outward via `inputState`; asserts (a)
  player never occupies a barrier tile, (b) player stays inside the
  disc (open-fence) or room (sealed-room), and (c) on kill every
  previously-blocked underlying-passable tile is passable again.

### Modified

- `src/core/world.ts` — added `barriers: BarrierRegistry`,
  `spawnerArenaBarriers: Map<number, BarrierHandle>`; removed
  `spawnerArenaFence` snapshot map. Initialised in `createGameWorld`.
- `src/core/map/FloorMap.ts` — added `barrierLookup` +
  `setBarrierLookup` + `hasBarrierAtTile`; `isPassableAt` consults
  barriers. Non-invasive: `hasBarrierAtTile` returns `false` when no
  lookup is installed, so existing test fixtures that skip the
  attach are unaffected.
- `src/core/map/pathfinding.ts` — `isTileTraversable` rejects
  barrier tiles for BOTH ground and flying modes.
- `src/core/spawner-arena.ts` — removed `FENCE_TILE_FLAGS`,
  `raiseFence`, `lowerFence`, `collectFenceRingTiles`,
  `assertFenceBlocks`. Kept `discFitsInRoom`, `isPlayerInArenaRadius`,
  `isArenaTriggered`, `decideArenaKind`, `SPAWNER_MAX_BANKED_CHILDREN`.
- `src/game/spawners/spawnerArenaSystem.ts` — uses
  `createRingBarrier` / `createRoomBarrier({doorwaysOnly:true})` /
  `dropBarrier`. No more raiseFence/lowerFence locals.
- `src/game/floorScenario.ts`, `src/game/floor2Scenario.ts` — call
  `attachBarriersToFloorMap(world)` after installing `world.floorMap`.
- `src/engine/scenes/MainGameScene.ts` — barrierOverlay init in
  `drawFloorTerrain`, per-frame `update()` (AFTER `sync()` so the
  existing door→lighting→sync sequence check still passes),
  destruction in `shutdown` and `drawFloorTerrain` re-init.
- `src/lab-main.ts` — registered `barrier-lab` in the module map.
- `tests/unit/spawner-arena.test.ts` — removed the
  `collectFenceRingTiles` import + geometry test block.
- `docs/knowledge/adr/README.md` — added ADR 0050 entry, bumped
  count/next-number.
- `docs/knowledge/adr/0044-spawner-battle-arena.md` — marked the
  fence section superseded by ADR 0050.
- `docs/knowledge/handoffs/2026-07-04-spawner-battle-arena.md` —
  notes for the fence-snapshot removal.
- `.specify/specs/spawner-battle-arena.md` — struck out the fence
  caveat under "Known implementation gaps"; updated the design
  section to point at the barrier primitive.

## Verification run

- `npm run typecheck` — ✅
- `npm run lint` — ✅
- `npm run format:check` — ✅
- `npm run test:unit` — ✅ 3802 passed
- `npm run test:integration` — ✅ 86 passed, 1 skipped
- `npm run check:wired-systems` — ✅ 46 systems, all wired
- `tests/headless/spawner-arena-caging-natural.test.ts` — ✅ all 8
  seeds pass (1..8). Both containment and release assertions hold on
  every seed.

## Deleted

- `raiseFence` — no callers.
- `lowerFence` — no callers.
- `FENCE_TILE_FLAGS` — no readers.
- `collectFenceRingTiles` — replaced by `collectRingTiles` in
  `src/core/barriers/geometry.ts`.
- `assertFenceBlocks` — no callers (was a debug helper).
- `world.spawnerArenaFence` — replaced by
  `world.spawnerArenaBarriers: Map<number, BarrierHandle>`.

Grep sweep confirmed zero remaining references in `src/` or `tests/`
to those names outside historical prose (ADR/handoff) which
explicitly marks them superseded. The VFX effect kind
`spawnerArenaFence` (a display shimmer name) is unrelated to the
deleted primitive code path and remains in place.

## Unresolved issues

None. All 10 acceptance criteria met.

## Recommended next steps

- If a future physics site is added, route it through
  `FloorMap.isPassableAt` (movement) or `isTileTraversable` in
  `src/core/map/pathfinding.ts` (A\*) — do NOT read `TileMap.flags`
  directly.
- If concurrent barrier count grows past a few dozen, consider a
  per-tile refcount map inside `BarrierRegistry` to make `dropBarrier`
  O(dropped tiles) instead of O(sum of remaining tiles).
