# Session Handoff: Generic special-room sealing (seed 42 tunnel breach)

## Date

2026-06-26

## Persona(s) adopted

Systems Engineer (map/core plumbing) under a Producer framing. The task was a
cross-layer bug fix that turned into a small generic sub-system, which is core
map/geometry work — Systems Engineer's wheelhouse.

## Routing verdict

✅ right persona — the fix lives in `src/core/map` + `src/game` plumbing with no
rendering or gameplay-balance concerns.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — new core module + cross-layer refactor + door-conversion + 5
files touched with tests, no ADR/lab needed; landed exactly at Medium.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Fixed "seed 42 still lets tunnels breach safe rooms" and generalised the fix per
the expanded requirements (seal **all** special rooms, generic system, sealed by
default with explicit opt-out).

Root cause: `floor1Scenario` tags extra rooms SAFE _after_ generation (welcome
office, shop, spell broker) and gates two boss rooms (slime-rat quest room,
rat-slime boss-stair room), bypassing the generator's special-room sealing. Those
post-gen rooms kept non-door perimeter "breaches" carved by corridors. The old
`sealRoomPerimeterOpenings` only sealed the primary safe room + slime-rat room,
and its all-or-nothing connectivity guard refused to seal seed 42's room 12 (a
4-way hub whose breaches are the only route to other rooms).

Changes:

- **New core util `src/core/map/special-rooms.ts`** (pure, deterministic):
  - `sealRoomPerimeter(floorMap, room)` — greedy per-tile guard. Walls each
    perimeter gap whose walling strands nothing reachable from spawn; converts
    the remaining **load-bearing** gaps to closed doors (`DOOR_CLOSED` +
    `TerrainType.DOOR`) and appends them to `room.doors`. Room ends fully enclosed
    by walls + doors only, stays connected, no softlock.
  - `sealSpecialRooms(floorMap, { roles?, extraRoomIds?, skipRoomIds? })` —
    generic entry point. Default roles `[SAFE, BOSS_STAIR]`; `extraRoomIds` adds
    non-role rooms (the slime-rat quest room); `skipRoomIds` is the "told NOT to
    seal" opt-out. Seals in ascending room-id order for determinism.
  - `DEFAULT_SPECIAL_ROOM_ROLES` exported.
- **Refactor `src/game/floor1Scenario.ts`**: `sealRoomPerimeterOpenings` is now a
  thin pixel→room wrapper that delegates to the core util (still exported for
  tests). The ad-hoc seal calls were replaced with a single `sealSpecialRooms(...)`
  call placed after the `tagRoomAsSafe` calls and before boss/slime-rat door-entity
  creation, so converted doors get DoorState entities + quest locks. Net −45 lines.
- **Tests**:
  - `tests/unit/special-rooms.test.ts` (new) — 8 cases: wall harmless breach,
    convert load-bearing breach → door + register on room, idempotency, default
    SAFE/BOSS_STAIR sealing, NORMAL ignored, `extraRoomIds`, `skipRoomIds` opt-out,
    custom role list.
  - `tests/game/floor1-scenario.test.ts` — seed-42 regression strengthened to
    assert **every** SAFE + BOSS_STAIR room **and** the slime-rat quest room are
    door-only (was just slime-rat + primary safe room).
  - `tests/game/seal-room-perimeter-openings.test.ts` — case 2 updated for
    door-conversion (load-bearing breach now becomes a registered door, not left
    open).

Verified seed 42: all 4 SAFE rooms now report 0 non-door perimeter breaches;
room 12's load-bearing gaps were converted to doors (door count 1 → 2).

## What's Next

- Optional follow-up: unify the generator's own `sealSpecialRoomPerimeters`
  (`DungeonGenerator.ts`) onto the new core util. Deliberately left out of scope
  here — the generator runs pre-FloorMap / pre-corridor-widening on rooms it
  already pre-validated as sealable, so consolidating it would widen the blast
  radius for little gain. Worth doing when someone next touches that path.
- Converted doors use `connectsTo: -1` (the gap had no recorded neighbour room).
  Full verify (incl. headless Floor 1 completion + build) is green, so minimap /
  rendering handle it fine, but keep an eye on it if door-graph traversal code
  later assumes `connectsTo >= 0`.

## Blockers

None.

## Branch State

- Branch: `nalfeo-cuddly-disco`
- All tests passing: yes (`verify:fast` 169 + full `verify` incl. integration,
  headless Floor 1 gate, build; `lab-gate-check.sh` passes)
- PR created: yes (see PR link)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no telemetry section.

## Test Results

- `npm run verify:fast` → 15 files, 169 tests passed.
- `npm run verify` → typecheck + lint + format + unit (coverage) + integration
  (25 passed, 1 skipped) + headless Floor 1 completion gate (44 passed) + build →
  ✅ Full verification passed.
- `bash scripts/agent/lab-gate-check.sh` → ✅ passed (no new ECS system added).

## Key Decisions Made

- **Convert load-bearing gaps to doors** (user-confirmed) instead of leaving them
  open. A closed door is non-passable (closes the architectural breach) yet
  auto-opens for the player and counts as pathable in connectivity floods, so the
  floor never softlocks.
- **Seal by default, opt-out via `skipRoomIds`** — matches the requirement that
  special rooms seal unless explicitly told not to.
- **Greedy per-tile sealing** (wall-then-reflood per gap against the cumulative
  walled set) rather than all-or-nothing, so a hub room seals every harmless gap
  and only the truly load-bearing ones become doors.
- **Did not modify the generator's sealing path** — see "What's Next".
