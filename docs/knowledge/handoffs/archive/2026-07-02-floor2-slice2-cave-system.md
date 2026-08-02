# Handoff: Floor 2 Slice 2 — CaveSystemGenerator

**Date:** 2026-07-02
**Branch:** `floor2-slice2-cave-system-v2`
**PR:** [#693](https://github.com/nalfeo/Crawler/pull/693)
**Status:** Complete; 29 new tests + full `npm run verify` green.
**Spec:** [`.specify/specs/floor2-family-territories.md`](../../../.specify/specs/floor2-family-territories.md) (FR1–FR3)
**ADR reference:** [`0040-floor2-family-territory-and-relationship-architecture.md`](../adr/0040-floor2-family-territory-and-relationship-architecture.md) decision D6

## What was done

Slice 2 lays down the raw geometry for Floor 2's family-territory floor: a rot-js
cellular cave with 3–4 family territories, a sealed boss den off each territory,
a settlement cavern, and a central resource-heart cavern. Everything is
deterministic from the seed and every labelled cavern is reachable from spawn.
Later slices bind bosses/dens (Slice 4), spawn the stair (Slice 5), and wire
family selection (Slice 8).

### New files

- `src/core/map/generators/cave-system.ts` — the generator. rot-js `Cellular` +
  `.connect()` for the base cavern, distance-transform local-maxima for region
  seeding, multi-source BFS partition for region membership, deterministic role
  assignment (heart by proximity to map centre; spawn/territories by distance
  from heart; settlement by size), boss-den carving with axis-aligned
  mid-edge door placement anchored to the target territory, then a reachability
  probe with up-to-8 sub-seed retries.
- `src/labs/cave-system-lab/index.ts` — GUI lab: seed slider, presentCount toggle
  (3/4), regenerate button, role-tinted cavern rendering with `F0..F3` family
  labels on territories/dens, red boss-den outlines, magenta resource-heart,
  gold settlement, spawn marker, and a red overlay for unreached tiles. Access
  via `npm run dev` and `?lab=cave-system-lab`.
- `scripts/agent/observe-cave-system.ts` — headless real-registry observation
  script: fetches the generator through `getGenerator(BiomeType.CAVE_SYSTEM)`,
  generates five seeds at 270×156, and reports per-seed timing, region count,
  role distribution, and reachability from spawn. Satisfies rule #10 by
  exercising the real biome-registry lookup rather than the lab shortcut.
- `tests/unit/cave-system-generator.test.ts` — 12 unit tests covering
  determinism, tile-count target ±20% at 270×156, role counts, reachability,
  retry-exhaustion diagnostic, BOSS_STAIR_FLOOR presence + bbox-locality across
  10 seeds, cavern semantic adjacency, and the wall-tile `getRoomAt = -1`
  invariant.
- `tests/unit/cave-system-generator.property.test.ts` — 2 fast-check invariants
  over a bounded seed range: role-count exact match and full-cavern
  reachability from spawn.
- `tests/integration/floor2-cave-map.test.ts` — 15 real-config seeds at 270×156
  through the biome registry; asserts 100% reachability + role counts + tile
  count target.
- `docs/knowledge/review-ledgers/2026-07-02-floor2-slice2.review-ledger.json` —
  3🍎 ledger (plan_review + code_review rounds with Copilot, gpt-5.4, and
  claude-sonnet-4.6).

### Modified files

- `src/shared/map-types.ts` — `BiomeType.CAVE_SYSTEM`; new `RoomRole` values
  `TERRITORY`, `BOSS_DEN`, `SETTLEMENT`, `RESOURCE_HEART`; new optional
  `RoomData.familyIndex` + `RoomData.interiorCells` (the latter is a mask for
  irregular-shape regions so `RoomGraph.getRoomAt` and `getRandomInteriorTile`
  don't misattribute wall tiles inside a cavern's bounding box).
- `src/core/map/RoomGraph.ts` — `add()` gained `familyIndex` and `interiorCells`
  params; new `addNeighbor(id, neighborId)` rebuilds the readonly neighbors
  array without casting; `buildSpatialCache` and `getRandomInteriorTile` prefer
  `interiorCells` when populated.
- `src/core/map/generators/registry.ts` — registers the new generator against
  `BiomeType.CAVE_SYSTEM`.
- `src/core/map/generators/index.ts` — re-exports `CaveSystemGenerator`.
- `src/shared/data/floors/floor2.manifest.json` — dimensions bumped to 270×156.
  The biome/present-count/family-and-resource config is Slice 8-owned; adding
  those keys here would fail the strict manifest schema, so the file
  intentionally stays minimally valid until Slice 8 extends the loader.
- `src/lab-main.ts` — registers the `cave-system-lab` dynamic-import entry.

## Design notes

- **Determinism / rule #3 & #4:** all randomness flows through the passed-in
  `seed`. Retries use `(seed + attempt * 7919) | 0` sub-seeds. No `Date.now()`
  or `Math.random()` in the generator or the observation script (the script
  uses `performance.now()` for its timing report).
- **Reachability / ADR 0021:** after generation, a flood from `playerSpawn`
  over passable tiles must reach every TERRITORY, SETTLEMENT, RESOURCE_HEART
  centroid, and the outside-tile of every boss-den door. On failure, the
  generator retries with a bumped sub-seed up to `maxRetries` (default 8) and
  throws with the full attempt log on exhaustion.
- **Sealing / ADR 0023:** boss-den perimeters are stamped as `STONE_WALL` and
  the one door as `DOOR_CLOSED`. The unlock objective wiring stays with
  Slice 4; each `BOSS_DEN` room carries `familyIndex` so Slice 4 can bind the
  door to the correct boss objective.
- **Boss-den door invariant:** the door is placed on an axis-aligned mid-edge
  (never a corner) with its outside tile guaranteed to be a member of the
  territory's `cells` set (Set-membership check), so the RoomGraph adjacency
  it advertises is real.
- **Stair hand-off / ADR reference:** the resource-heart centre is stamped
  with `TerrainType.BOSS_STAIR_FLOOR` (Floor 1's stair-spawn tile role), with
  a fallback to the region's deepest passable cell if the arithmetic centroid
  lands on a wall pocket. Slice 5 flips a flag to spawn the stair on that tile
  — no room-role plumbing changes needed.

## Verification

- `npm run verify` (typecheck + lint + wired-systems + full unit/integration
  suite + pr-prereqs + build) — green.
- `tsx scripts/agent/observe-cave-system.ts` — five seeds at 270×156 all
  produce 11 rooms with the expected role distribution (spawn 1, territory 4,
  settlement 1, resource_heart 1, boss_den 4) and 100% labelled-cavern
  reachability from spawn.

## Known gaps / follow-ups

- **Slice 4:** boss-spawn wiring + den unlock objectives (bind each BOSS_DEN's
  `familyIndex` to a real boss).
- **Slice 5:** flip the stair-spawn flag when the resource-heart's win
  condition trips; consume the pre-stamped `BOSS_STAIR_FLOOR` tile.
- **Slice 8:** extend the floor-manifest loader schema to read `biome`,
  `presentCount`, and family/resource/shop config, then wire Floor 2 into the
  real scenario runner so `getGenerator(manifest.biome)` selects
  `CaveSystemGenerator` from production data.
- **Slice 3 nice-to-have:** boss-den interior reachability _after_ the door
  opens (the current reachability check accepts territory-side neighbours
  because `DOOR_CLOSED` is not passable pre-unlock).

## Related work

- Sibling cloud session landing Slice 1 (family data + relationships) at the
  same time. Slice 2 does not import from `families.json` or Slice 1 symbols;
  it takes only integer `presentCount` and `familyIndex` values.
