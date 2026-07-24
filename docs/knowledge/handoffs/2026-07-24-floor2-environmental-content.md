# Handoff: Floor 2 Industrial-Cave Environmental Content

**Date:** 2026-07-24
**Session slug:** floor2-environmental-content
**PR:** closes #1903
**Apple estimate:** 3🍎 actual: 3🍎

## Systems touched

floor2-scenario, decoration-defs, harvestable-defs, prop-placer, floor-manifest

## What was done

Added three buckets of Floor 2 industrial-cave environmental content:

### 1. Harvestables (ore/gem nodes)
- `src/shared/harvestableDefs.ts`: Appended 3 Floor 2 defs at **stable indices 6–8**:
  - `iron-vein` (index 6) → drops `iron-ore`, 4.5 s harvest
  - `copper-seam` (index 7) → drops `copper-ore`, 4 s harvest
  - `gem-cluster` (index 8) → drops `void-crystal`, 7 s harvest + light glow
- Exported `FLOOR2_HARVESTABLE_START_INDEX = 6` as the **shared floor boundary constant** so both `floorScenario.ts` (Floor 1 upper bound) and `floor2Scenario.ts` (Floor 2 lower bound) stay in sync.
- `src/game/floor2Scenario.ts`: Added `spawnFloor2HarvestableNodes(world)` which iterates defs `[6..HARVESTABLE_DEFS.length)` and places nodes in NORMAL/SPAWN rooms using `world.rng`.

### 2. Ambient lighting
- `wall-lantern-cave` (index 24): warm orange light (0xffa040, 18 ft, 0.65 intensity), wall-adjacent, animated 3-frame
- `glowing-crystal-shard` (index 25): purple light (0x8844ff, 14 ft, 0.5 intensity), cave-only placement
- `gem-cluster` harvestable: glowing node with 8 ft light
- All placed via the existing `PropLight` component path in `spawnProp`.

### 3. Props (set-dressing)
- `src/shared/biome-tags.ts`: Added `'cave'` to `BiomeTag` union.
- `src/shared/floor-manifest.ts`: Added `'cave'` to Zod biomeTag enum.
- `src/shared/decorationDefs.ts`: 6 cave defs appended at **stable indices 20–25** (`DECORATION_DEF_INDEX` is append-only):
  - `mining-cart` (20): structural, room-only, weight 300
  - `support-beam` (21): structural, wall-adjacent, weight 500
  - `cave-rubble` (22): rubbish, anywhere, weight 80
  - `pipe-section` (23): structural, wall-adjacent, weight 150
  - `wall-lantern-cave` (24): light-source + PropLight
  - `glowing-crystal-shard` (25): light-source + PropLight
- `src/shared/data/floors/floor2.manifest.json`: Added `"props"` block `{biomeTag:"cave", densityMultiplier:0.8, allowedCategories:["rubbish","light-source","structural"]}`.
- `src/game/floor2Scenario.ts`: Calls `placePropsForFloor(world, world.floorMap!, manifest.props, world.rng)` after settlement initialization.

### Lab gate
- `src/labs/prop-lab/index.ts`: Added `BiomeTag` import, `biomeTag: BiomeTag` field to `PropLabSettings`, GUI dropdown including `'cave'`. The prop-lab is the required lab for decorationDefs changes.

## Critical bug caught + fixed

**Code reviewer found:** `spawnFloor1HarvestableNodes` in `floorScenario.ts` iterated `for defIndex = 0; defIndex < HARVESTABLE_DEFS.length` — **after adding Floor 2 defs, the uncapped loop would spawn iron-vein/copper-seam/gem-cluster nodes on Floor 1.**

**Fix:** Capped the Floor 1 loop at `defIndex < FLOOR2_HARVESTABLE_START_INDEX`. Removed the redundant local re-declaration of the constant in `floor2Scenario.ts` (now imported from `harvestableDefs.ts`). Added regression test.

## Tests added

- `tests/game/floor2-environmental-content.test.ts`: unit tests for def indices, categories, lightEmission, prop placement determinism, full scenario boot, and **Floor 1 regression guard** (no Floor-2 nodes spawned on Floor 1)
- `tests/unit/floor2-environmental-content-wiring.test.ts`: source wiring tests including the Floor-1 spawner loop bound

## Key invariants to maintain going forward

- `HARVESTABLE_DEFS` array is **append-only** — never reorder. Floor 1: 0–5, Floor 2: 6–8.
- `FLOOR2_HARVESTABLE_START_INDEX = 6` is the single source of truth for the floor boundary. If Floor 2 defs are added before index 6, this constant must be updated accordingly.
- `DECORATION_DEF_INDEX` is **append-only** — never reorder. Cave defs: 20–25.
- No new PNG art was required — placeholder `spriteId` strings are used; the renderer falls back to a tinted rect until real sprites land.

## Validation

- Plan review: posted on issue #1903 before coding (issue comment).
- Code review: 1 round, 1 critical regression found + fixed (see above).
- Review ledger: `docs/knowledge/review-ledgers/2026-07-24-floor2-environmental-content.review-ledger.json`
- Secret scan: clean.
- Tests: CI will validate (node_modules not available locally in agent sandbox).
