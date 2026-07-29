# Session Handoff: Split DungeonGenerator monolith into dungeon/ modules

## Date

2026-06-29

## Persona(s) adopted

**Engine/Systems** — the work is an in-layer decomposition of a core map-generation
module (`src/core/map/generators/`), pure ECS-adjacent logic with strict
determinism requirements. No multi-layer coordination, so no Producer split needed.

## Routing verdict

✅ right persona — a behavior-preserving refactor of deterministic core logic is
squarely Engine/Systems territory.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — Medium in-layer split: 8 new modules + thin facade + a golden
guard, 3–10 files, tests required, no ADR. Went byte-identical on the first pass,
so it neither ballooned to 4 nor shrank to 2.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

mapgen

## What Was Done

Decomposed the **1726-line** `src/core/map/generators/DungeonGenerator.ts` monolith
into eight cohesive modules under `src/core/map/generators/dungeon/`, behind an
**unchanged public facade**. Pure pipeline passes moved out **verbatim**; the
`DungeonGenerator` class + `generate()` orchestrator stay and import them.

**Behavior-preservation guard (added FIRST, captured from `main` before moving code):**

- `tests/determinism/dungeon-generator-golden.test.ts` + committed snapshot.
- 3 configs (flat dungeon, room-variety, cave-regions) × seeds 1–10 = 30 maps.
- Snapshots terrain bytes (FNV-1a hash), room bounds/roles, door locations +
  `connectsTo`, neighbors, and player spawn. `SeededRandom` only.
- After the split the **same** test reproduces **byte-identical** output → proof of
  zero behavior change.

**Modules (no import cycles; `reachability`/`room-shapes` depend only on `doors`):**

| Module            | Functions                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `doors.ts`        | `getDoorSide`, `ensureDoorAccess`, `pruneInaccessibleDoors`, `expandDoorsForWideCorridors`                                                |
| `reachability.ts` | `floodReachableTiles`, `cullIsolatedFloorTiles`, `roomInteriorStatus`, `buildRoomBlockMask`, `carveRoomConnector`, `ensureRoomsReachable` |
| `room-shapes.ts`  | `applyRoomShapes`, `applyEllipseShape`, `selectLShapeQuadrant`, `applyLShape`                                                             |
| `corridors.ts`    | `widenCorridors`, `addDiagonalShortcuts`, `carveBresenhamPath`                                                                            |
| `roles.ts`        | `preAssignRoles`                                                                                                                          |
| `room-fill.ts`    | `sealSpecialRoomPerimeters`, `buildSpecialRoomWalls`, `paintRoomFloor`                                                                    |
| `adjacency.ts`    | `computeRoomAdjacency`                                                                                                                    |
| `caves.ts`        | `buildCaveProtectedMask`, `carveCaveRegions` (+ `CAVE_*` consts)                                                                          |

**Public surface preserved:** `DungeonGenerator`, `SPECIAL_ROOM_MIN_WIDTH/HEIGHT`,
and `DungeonGeneratorOptions` stay in `DungeonGenerator.ts`. `ensureRoomsReachable`
moved to `dungeon/reachability.ts` but is **re-exported** from `DungeonGenerator.ts`,
so `registry.ts`, `index.ts`, and `tests/ecs/*` import paths are unchanged. Diff
stays inside `src/core/map` (one layer — no ADR).

`DungeonGenerator.ts`: 1726 → ~287 lines.

## Files touched

- `src/core/map/generators/DungeonGenerator.ts` (now a thin facade)
- `src/core/map/generators/dungeon/{doors,reachability,room-shapes,corridors,roles,room-fill,adjacency,caves}.ts` (new)
- `tests/determinism/dungeon-generator-golden.test.ts` + `__snapshots__/*.snap` (committed earlier, 89c9f33a)

## What's Next

- Nothing required — the split is complete and proven. Future map-gen work now lands
  in a focused module instead of a 1700-line file.
- Optional follow-up (separate session): the golden harness could be generalized to
  guard other generators in `src/core/map/generators/` (e.g. cellular/cave) the same way.

## Blockers

None.

## Branch State

- Branch: `nalfeo-split-dungeon-generator`
- All tests passing: yes (`npm run verify` full suite, incl. headless Floor 1 gate)
- PR created: yes (opened with auto-merge armed)

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "deny": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```

The single `pr-preflight` deny was the handoff-required gate firing on the first
`create_pull_request` attempt — resolved by adding this handoff, then retrying.

## Test Results

`npm run verify` — all green:

- typecheck, full-tree lint, Prettier check ✓
- unit (259) incl. golden determinism guard (2) ✓
- integration (49 passed / 1 skipped) ✓
- headless Floor 1 completion + win-rate gate (17) ✓
- build ✓

Golden guard byte-identical before/after the split. External-importer suites
`tests/ecs/map-generators.test.ts` (37) and `tests/ecs/ensure-rooms-reachable.test.ts`
(5) pass against the preserved public surface.

## Key Decisions Made

- **Golden-first.** Captured the determinism snapshot from `main` before touching
  code so the guard is an honest behavior baseline, not a post-hoc rationalization.
- **Verbatim extraction.** Function bodies moved unchanged (verified against the
  original source line-for-line); only import paths and `export` keywords differ.
- **`carveRoomConnector` → `reachability.ts`** (not `corridors.ts`): it is only
  called by `ensureRoomsReachable` and uses `getDoorSide`; grouping it with
  reachability keeps `corridors.ts` from depending on `doors.ts` and avoids a cycle.
- **Re-export over moving the export site.** `ensureRoomsReachable` is re-exported
  from `DungeonGenerator.ts` to keep every external import path stable.
- **No `.js` import extensions** in `dungeon/` — matches the `map/generators` area
  convention (spawners use `.js`, but that is not the convention here).
