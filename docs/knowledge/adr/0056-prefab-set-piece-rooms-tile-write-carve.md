# ADR 0056: Prefab set-piece rooms own real walls + doors as mapgen tile writes

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 4 — runtime gameplay + shipped game data. Touches mapgen carve (`src/core/map`),
Floor 1 scenario wiring + the reachability gate (`src/game`), the schema
(`src/shared/set-piece-types.ts`), all 13 set-piece defs (`src/shared/data/set-pieces.json`),
and the map-gen lab overlay (`src/labs`). The tooling-cap does NOT apply because runtime
geometry and shipped data change.

## Context

Hand-authored set pieces (the Floor 1 welcome office is the only production one today,
stamped at `floorScenario.ts:1852`) were **render-only dressing**: `stampSetPiece.ts`
centred the def inside an existing generated room's 1-tile-inset interior and clamped
overflowing props, emitting render sidecars with **zero collision**. The room's only real
walls were the generator's own perimeter; the prefab contributed no impassable geometry and
no real door in `RoomData.doors[]`. A set piece was a picture painted on a plain box, not a
room — the "scattered props in a box" slop model.

Two hard constraints shaped the fix:

1. **The entity-free determinism invariant** (`src/core/spawners/world-objects.ts`):
   set-piece props are render-only and must **never** become ECS entities, because
   allocating entity ids for dressing shifts ambient-mob/drop ids, perturbing
   collision-pair enumeration order and the global RNG — breaking headless↔rendered
   byte-for-byte determinism. So walls and doors **cannot** be spawned as entities; they
   must be **tile writes** during map generation.
2. **Floor 1 must stay winnable throughout** — the welcome room is on the critical path,
   and downstream safe-room sealing + boss-stair/quest door gating read `room.doors`.

The tile model already supported everything needed (`TileFlags.PASSABLE/TRANSPARENT/DOOR`,
`TilePresets.WALL/DOOR_OPEN`, `TerrainType.STONE_WALL/DOOR`, `RoomData.doors`), and
`applyWelcomeRoomStructuralTiles` was already a tile-write path — a better extension point
than a rewrite.

## Decision

A `SetPieceDef` becomes an **authoritative prefab room** that owns its own shell, and map
generation **carves the target room to the prefab footprint** with the shell landing as
**tile writes**:

- **Schema:** add `doorSlots` (`fixed` — pinned to a wall tile; `dynamic` — eligible wall
  edges, mapgen picks the straightest connection) to `SetPieceDef` with a Zod `superRefine`,
  plus `resolveSetPieceDoorSlots(def)` returning the deterministic authored door set.
- **Core carve** (`src/core/map/carveSetPieceRoom.ts`, pure): resize the hub
  `RoomData.bounds` to the footprint (**COINCIDE** — the prefab wall ring maps exactly onto
  the room perimeter, one wall, one source of truth), **reject** any footprint that would
  overlap a neighbour room (`fitted:false`, no mutation), punch the declared/resolved doors,
  `sealRoomPerimeter` convert load-bearing ring breaches (crossing corridors) into
  **additional** doors so no region strands, and a connector backstop carve from the primary
  door if the interior is unreachable. All door resolution is deterministic (SeededRandom /
  fixed tie order — never `Math.random`).
- **Production wiring:** `carveWelcomeRoomPrefab` (`src/game/floorScenario.ts`) replaces the
  render-only path for the welcome room and threads its `fitted` result into scenario state.
- **Reachability gate** (`src/game/set-piece-reachability.ts`, the zero-tolerance
  deliverable): per seed, over the **real** `initializeFloor1Scenario`, assert the prefab
  **actually applied** — not merely that the room is reachable. A no-fit degrades to the
  legacy render-only stamp, which has **no impassable walls** and is therefore trivially
  reachable, so a reachability-only gate would be **strongest exactly when the feature
  failed**. The gate is lock-aware and reports the render-only degradation count as a
  first-class number; **degradation > 0 is a hard failure**.

**`carved` is derived from ground truth, not a proxy.** Floor 1's room-size config
(`roomWidthRange:[10,22]`, `roomHeightRange:[9,20]`) permits the generator to emit a
coincidentally-10×9 welcome room; on a no-fit the room keeps its bounds and safe-room sealing
hardens the perimeter, so `bounds == footprint` could be true on a degraded floor. The gate
therefore persists `carveWelcomeRoomPrefab`'s `fitted` into `scenario.welcomeRoomCarved` and
gates on that; `bounds == footprint` survives only as a defense-in-depth assertion for a
`fitted` carve.

## Consequences

### Positive

- Set pieces are real rooms with real, impassable walls and real `RoomData` doors — downstream
  safe-room sealing and boss/quest door gating see them correctly.
- The determinism invariant is preserved: everything is a tile write, zero new ECS entities.
- The reachability gate proves the **authoritative carve** applied (100% of set-piece rooms
  reachable + doors/anchors pathable), with render-only degradation a loud, first-class hard
  failure rather than a silent fall-through — so a green sweep means the feature worked, not
  that it quietly failed.
- Observed on the real production path (not a lab): welcome-room carves a 10×9 room with a full
  impassable wall ring, one real DOOR on the ring, 0 perimeter breaches; seed 21 (previously
  lock-stranded) passes. Local sweep 1–150: 150/150, 0 degradations.

### Negative

- The welcome room is now geometry-authoritative: an under-powered carve (no space, neighbour
  overlap) degrades to render-only and **fails the gate** rather than silently shipping. That
  is intentional (a signal, not a resting state) but means the prefab footprint and the Floor 1
  room-size config must stay compatible.

### Risks

- **False-green via proxy (found + fixed in round-2 review):** deriving `carved` from
  `bounds == footprint` let a coincidentally-sized degraded floor report an authoritative carve.
  Resolved by gating on the persisted `fitted` ground truth (see Decision).
- **Grown-carve swallowing a third-party corridor/room:** mitigated by step-3 overlap rejection
  - `sealRoomPerimeter` load-bearing→door conversion + a topological no-strand gate check that
    asserts every room stays reachable after the carve. A conservative neighbour fit-check falls
    through to render-only rather than consuming another room's tiles.

## Alternatives Considered

The adversarial plan review (gpt-5.4) enumerated two alternatives and argued against each:

- **A — drive prefab sizing INSIDE the rot-js `DungeonGenerator`:** rejected — couples mapgen
  to set-piece data, breaks the pure post-generation tile-write seam, and cannot honour the
  entity-free determinism invariant cleanly.
- **B — keep the render-only stamp and add a separate impassable-collision overlay layer:**
  rejected — two sources of truth for walls, doors never land in `RoomData.doors` so downstream
  safe-room/boss-door gating stays blind, and reachability cannot be asserted on the real tile
  grid.
- **Chosen — COINCIDE-with-room-perimeter carve as post-generation tile writes:** the prefab
  ring IS the room wall; doors are real `RoomData` doors; reachability is asserted on the actual
  tile grid. Survived the red-team.

Grounded design decision (recorded as intended, not a defect): the carve emits **at least** the
def's declared door count, not exactly — `sealRoomPerimeter` must convert load-bearing ring
breaches into additional doors to avoid stranding regions, so declared slots are a **minimum**
(`>=` in the gate).
