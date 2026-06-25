# ADR 0023: Generic special-room perimeter sealing with door-conversion

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 3 — touches `src/core/map` + `src/game` (2 layers) but adds no new ECS
system or lab; a pure deterministic map utility plus its wiring.

## Context

Floor 1 designates several rooms as "special" **after** map generation:
`floor1Scenario` tags the welcome office, shop and spell-broker rooms `SAFE`, and
gates two boss rooms — the slime-rat quest room and the rat-slime boss-stair room.
Procedural corridors are carved between room _centres_, so they routinely clip the
bounding-box perimeter of a room at non-door tiles. For an ordinary combat room
that is harmless, but for a special room each such gap is a **breach** an enemy
can tunnel through (reported on seed 42).

The generator already seals the one `SAFE` + one `BOSS_STAIR` room it picks, and
deliberately picks rooms whose perimeters are sealable. But rooms designated
special _post-generation_ bypass that path entirely. The earlier ad-hoc fix
(`sealRoomPerimeterOpenings` in `floor1Scenario`) only sealed the primary safe
room + slime-rat room, and used an **all-or-nothing** connectivity guard: if
walling any breach would strand a spawn-reachable tile, it sealed nothing. Seed
42's room 12 is a 4-way connectivity hub (1 door + 3 load-bearing gaps), so the
guard refused and left it fully breached.

Requirements expanded during the session: sealing must apply to **all** boss
rooms, special-room tagging should be a **generic** system, and special rooms
should be **sealed by default unless explicitly told not to**.

## Decision

Introduce a generic, deterministic core utility `src/core/map/special-rooms.ts`
and route Floor 1 through it instead of bespoke per-room seal calls.

- `sealSpecialRooms(floorMap, { roles?, extraRoomIds?, skipRoomIds? })` seals
  every special room. Default roles are `[SAFE, BOSS_STAIR]`. `extraRoomIds`
  covers rooms with no special `RoomRole` (the slime-rat quest room is `NORMAL`).
  `skipRoomIds` is the **opt-out** that satisfies "sealed by default unless told
  not to". Rooms are sealed in ascending id order for determinism.
- `sealRoomPerimeter(floorMap, room)` replaces the all-or-nothing guard with a
  **greedy per-tile** guard. For each perimeter gap, in fixed order, it walls the
  gap if doing so strands nothing reachable from spawn (checked against the
  cumulative walled set); otherwise it converts the gap to a **closed door**
  (`TilePresets.DOOR_CLOSED` + `TerrainType.DOOR`) and appends it to `room.doors`.

A closed door is non-passable (closing the architectural breach) yet auto-opens
for the player and counts as pathable in connectivity floods, so a load-bearing
gap becomes a proper gate without softlocking the floor. `floor1Scenario` calls
`sealSpecialRooms` after safe-room tagging and **before** boss/slime-rat
door-entity creation, so converted doors still receive DoorState entities + quest
locks. `sealRoomPerimeterOpenings` is retained as a thin pixel→room wrapper that
delegates to the util (kept for existing tests).

The util lives in `src/core` (pure, no ECS/rendering imports) so it is portable
and unit-testable in isolation; `src/game` owns only the Floor 1 wiring.

## Consequences

### Positive

- All special rooms (every `SAFE`, every `BOSS_STAIR`, plus opt-in extras) are now
  enclosed by walls + doors only. Seed 42's 4 safe rooms report 0 breaches.
- Connectivity hubs that the old guard skipped are now sealed: their sole-route
  gaps become doors rather than open holes.
- Sealing is generic and reusable; "seal by default, explicit opt-out" matches the
  stated policy and is covered by unit tests.

### Negative

- Converted doors carry `connectsTo: -1` (the breach had no recorded neighbour
  room), so they are not full graph edges. Door gating/locking and rendering only
  need tile coordinates, so this is acceptable, but door-graph traversal that
  assumes `connectsTo >= 0` must continue to tolerate `-1`.

### Risks

- A room could, in principle, accrue more doors than intended if a corridor clips
  it many times. Bounded by perimeter length and proven harmless on the full
  verify suite (incl. the headless Floor 1 completion gate).

## Alternatives Considered

- **Leave load-bearing breaches open** (previous behaviour): rejected — it is the
  exact bug; enemies tunnel through open gaps.
- **Keep the all-or-nothing guard**: rejected — it cannot seal connectivity hubs
  like seed 42 room 12 without stranding regions.
- **Reroute corridors so they never clip special-room perimeters at generation
  time**: larger blast radius in `DungeonGenerator`, and post-gen tagging would
  still need a guarantee. Deferred.
- **Unify the generator's `sealSpecialRoomPerimeters` onto the new util now**:
  deferred — the generator runs pre-FloorMap / pre-corridor-widening on
  pre-validated rooms; consolidating it adds risk for little immediate gain.
