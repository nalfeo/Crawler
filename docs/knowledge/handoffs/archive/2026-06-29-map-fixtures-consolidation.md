# Session Handoff: Map-fixtures consolidation (refactor workstream D)

## Date

2026-06-29

## Persona(s) adopted

QA Engineer — a tests-only consolidation whose hard requirement (preserve every
test's exact map; a green suite is the proof) is squarely a test-integrity
concern, not a gameplay or architecture one.

## Routing verdict

✅ right persona — single-concern `tests/**` refactor, no `src/` change, no ADR.
The whole risk surface is "did any map silently change?", which is QA's domain.

## Apples

Estimated: 🍎 x 2 <!-- brief said "~🍎🍎"; "a test suite" -->
Actual: 🍎 x 3
Verdict: 📉 Under — breadth pushed it to Medium: a new ~344-line helper module +
a 15-test contract suite, **21 files touched** (more than the brief's 4+3),
several extra cross-file dupes discovered beyond the brief
(`makeWalledMap` ×3, `makeDiagonalCornerMap` ×2, `makePathMap` ×2,
`makeOpenFloorMap`/`makeFloorMap`, `makeAllWallMap`, `makeTerrainGrid`), and a
mid-flight rebase conflict with sibling #485 that had refactored the same
`behavior-tree-ai` diagonal-corner test.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Consolidated copy-pasted map-builder helpers scattered across the test suite
into ONE shared module, `tests/helpers/map-fixtures.ts` (co-located with
`world-factory.ts`). Net **−527 lines** of duplicated fixture code across 19
consumer files.

**Nine builders**, each reproducing its callers' original map exactly; subtle
differences expressed via options so no test's map changes:

- `makeMapWithSafeRoom(opts)` ← aoe-on-impact, area-damage-branches,
  beam-branches, safe-room (`{withNormalRoom:true}`), damage-branches
  (`{widthTiles,heightTiles,tileSizeFt,maxRooms,spawn}`)
- `makeMapWithDoor()` ← door-lock, door-navigation, door-system (byte-identical)
- `makeMapWithSafeRoomDoor()` ← door-system-safe-room
- `makeWalledMap(opts)` ← movement, knockback, ability-system (`{tileSizeFt:4}`)
- `makeDiagonalCornerMap(opts)` ← movement, behavior-tree-ai (`{seed,floorDensity}`)
- `makePathMap(doorOpen, opts)` ← pathfinding (default ts32), flow-field (`{tileSizeFt:4}`)
- `makeOpenFloorMap(wallColumnX?)` ← melee-returning-coverage, weapon-coverage (byte-identical)
- `makeAllWallMap(w, h)` ← ensure-rooms-reachable (returns `{tileMap, terrain}`)
- `makeTerrainGrid(rows)` ← tile-visuals (returns `{terrain, width, height}`)

Added a contract-lock suite `tests/unit/map-fixtures.test.ts` (15 tests) pinning
each builder's exact output + every option branch.

**Deliberately left local** (NOT true duplication / too divergent): flow-field's
`makeOpenMap` (20×20-vs-12×9, seed7) and all single-use builders. Files that keep
other local FloorMap builders (`behavior-tree-ai`, `flow-field`) retained their
map-type imports; only the duplicated builder was extracted from each.

## What's Next

Remaining backlog from the refactor fan-out (see
`2026-06-29-refactor-cleanup-review.md`): decompose `floorScenario` and the
engine god-classes (MainGameScene/PhaserBridge — need e2e/probe guards first,
~0% UT), `DungeonGenerator` split, property suites (loot/inventory/xp). The
map-fixtures consolidation item on that backlog is now **done**.

## Blockers

None.

## Branch State

- Branch: `nalfeo-consolidate-map-fixtures`
- PR: #486 (open, auto-merge SQUASH armed)
- Rebased onto latest `main` (includes #485); one conflict in
  `behavior-tree-ai.test.ts` resolved by combining #485's extracted
  `hasClearLineOfSight(world.floorMap, …)` assertion with the new
  `makeDiagonalCornerMap({ seed: 1, floorDensity: 1 })` fixture call.
- All tests passing: yes (full `npm run verify` green, pre- and post-rebase).

## Agent-OS Telemetry

No `files/guard-telemetry.jsonl` this session.

## Test Results

`npm run verify` — all 8 steps green (typecheck, lint, format, 2649 unit + 49
integration + 17 headless Floor-1 gate, production build). A green full suite is
the proof that every consolidated map is byte-identical to its original;
reinforced by exact reproduction by construction and the new contract-lock suite.

## Key Decisions Made

- **Diff before merge.** Diffed every duplicate copy; only collapsed
  byte-for-byte-equivalent builders. Genuine divergences (tile size 32-vs-4,
  seed, spawn, floor density, an extra NORMAL room in `safe-room`) were
  parameterized via options — never forced together.
- **Preserve the test, fix the fixture.** No assertion weakened or deleted; the
  green suite + exact construction is the consolidation's correctness proof.
- **Aliased imports** (`makeAllWallMap as makeMap`, `makeTerrainGrid as makeMap`)
  for the two object-returning builders to keep 17 call sites unchanged while the
  canonical exports stay well-named.
