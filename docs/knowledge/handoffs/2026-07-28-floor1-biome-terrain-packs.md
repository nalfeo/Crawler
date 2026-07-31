# Floor 1 biome terrain packs

## Systems touched

terrain, rendering, sprites, floors

## What shipped

Floor 1 moves off the legacy `TILE_VISUALS` path onto the terrain-pack system,
with **two packs rendered co-resident on the same map**:

- `floor1-dungeon` — stone masonry walls, floors, corridors, wooden doors, plus
  three role-keyed special-room floor pools (welcome/spawn, safe, boss-stair),
  4 variants each.
- `floor1-cave` — cave rock walls and floors. Corridors and doors deliberately
  route through the dungeon pack so the two biomes share circulation.

Region-to-pack assignment lives in `floor1.manifest.json` under `terrainPacks`
(`stone` / `cave`), which the renderer resolves per terrain family.

Art is Azure-generated material textured onto the tracked blob47 silhouette
geometry. Generation supplies **texture only**; local deterministic code owns
geometry, pooling, lighting normalization, and validation.

## Observe before done

Real `MainGameScene` via `main-scene-probe-lab` (not a lab-only check):

| metric                | before | after     |
| --------------------- | ------ | --------- |
| generatedCount        | 32342  | **0**     |
| packWallCount         | 0      | **22196** |
| packFloorCount        | 0      | **9079**  |
| packCorridorCount     | 0      | **1169**  |
| packSpecialFloorCount | 0      | **1058**  |

`packFloorSourceCounts` is evenly spread across all four variants
(2222/2307/2282/2268), confirming the pool actually varies rather than pinning
one tile.

## Review-driven changes (all three were found by review, none by me)

**1. The boss-stair floor inverted the value hierarchy.** It was authored at
`targetMeanLuminance: 58` while the wall targets 62 — the floor read _darker
than its own walls_ in the one room a player is guaranteed to end the floor in.
Floor 2's ADR names this exact failure (they burned five procedural wall
iterations before realising the problem was tonal, not textural). Confirmed
empirically before fixing: dungeon wall 59.9, normal floor 74.4, welcome 84.7,
safe 82.4, boss-stair **58.3**. Raised to 70 — still the darkest floor, now
clearly above the wall. Measured 70.7 after. The fix cost nothing in Azure spend
because normalization is local and re-derives from the cached raw material.

Added a permanent **value-hierarchy guard** asserting every ground surface
exceeds the wall atlas mean. Verified it fails on the pre-fix art, flagging
exactly the four boss-stair tiles and nothing else.

**2. `validateAuthoredSilhouetteExact` was missing from CI.** The committed-art
suite called only `validateCompatibleBoundaries`, which samples the four cardinal
edge bands. `validate.ts`'s own docstring says an interior-only defect scores a
perfect 1.000 on that check — so when #2189 changed the canonical blob47
geometry, both atlases silently went stale with every gate green. It surfaced
only because someone ran the validator by hand. Added the exact check.

> Follow-up: `industrial-cave`'s committed-art test has the **same gap**. Not
> fixed here to keep the diff owned, but it is a real hole in another pack.

**3. The art was detectably stale but not repairably reproducible.** `gen/cli.ts`
rebuilt only from a **gitignored** cache, so after a geometry change like #2189
only the original author's machine could recompose. Meanwhile `industrial-cave`
already commits `wall-material.png` and `rebuild-shared-base-pools.ts:515` reads
it from the tracked pack dir — the convention existed and these packs broke it.

Each pack now commits its two normalized source tiles (~10 KB total) and
`gen/cli.ts --from-source` rebuilds from them with no Azure and no cache.
**Verified by physically removing the cache directory and rebuilding: all 42
PNGs reproduced byte-for-byte.** A fixed-point test pins this in CI, and a
negative control confirms it fails on a wrong source.

Note the limit: committing _normalized_ tiles makes geometry recomposition
reproducible but does **not** allow re-tuning luminance targets, which needs the
raw material. That was judged the right trade (10 KB vs 19 MB) and matches
convention, but it is a real constraint on future retexturing.

## Rejected review remedy (recorded deliberately)

`gemini-3.1-pro-preview` correctly observed that `floor1-cave`'s `doorSet` and
its four door PNGs never render — `MainGameScene` resolves
`terrainPacks.stone ?? terrainPackId ?? terrainPacks.cave`, so stone always wins
on Floor 1. Its proposed fix was to delete them. **Rejected**: `doorSet` is
required by `terrain-pack-types.ts:458` with no `.optional()`, so removal fails
schema validation, and the `terrainPacks.cave` fallback makes them reachable for
any future cave-only floor. This is a cost of the pack contract, not a defect.

## Traps worth carrying forward

- **A pack ships inert unless `BootScene.preload()` loads it.** Lab-green proves
  nothing. There is now a test asserting the renderer _degrades to the legacy
  path_ rather than crashing when textures are absent — because that failure is
  otherwise completely silent.
- `authored` provenance means the validator demands a **100%** edge pass rate.
  A transparent pixel classifies as luminance 255 ("open"), so alpha must come
  from the silhouette untouched and wall material must stay dark. This is why a
  value-hierarchy problem must be fixed by **raising the floor**, never by
  darkening the wall.
- Wall tiles stamp **twice** since #1968 (floor underdraw, then atlas). Assert on
  _which pack_ a tile resolved to, never on stamp index.
- Wall atlas cells are **origin-anchored** (`tx * tileSize`); pool tiles are
  **centre-anchored** (`+ tileSize / 2`). The half-tile difference is what keeps
  the underdraw registered to its wall. Now pinned by a test.
- `tests/unit/sprites/**` is the `sprites` vitest project, **excluded** from
  `unit`. Running it with `--project unit` silently reports "No test files
  found".
- `gen/cli.ts` has no `--help`; unknown flags throw. Flags are `--force`,
  `--compose-only`, `--from-source`, `--pack <id>` (repeatable).
- Materials load **serially** in `gen/cli.ts` on purpose — the S0 image tier
  throttles, and a 429 storm is slower than issuing one at a time. Do not
  parallelise.

## Known gaps (not blocking)

- Floor 1 uses **none** of Floor 2's variance mechanisms:
  `packFloorTransformCounts: {none: 9079}`, zero accents, zero decals, no
  linework. This pack predates those. Worth a variance pass, but sequencing
  matters — #2184 linework has landed, so a pass now would be matching a stable
  target.
- PR #2098 landed seven unwired `welcome-room-floor-plate-*.png` that overlap the
  four wired `special-welcome-*.png` here. Duplicate art worth reconciling.
