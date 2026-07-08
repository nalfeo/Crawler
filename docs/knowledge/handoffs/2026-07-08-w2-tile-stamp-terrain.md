# Handoff: w2 — Floor-1 terrain stamps approved generated tile textures (4/6 types)

## Systems touched

sprite-pipeline, mapgen

## Summary

The last remaining Floor-1 **art** gap: terrain was baked 100% from Kenney
placeholder spritesheet frames even though 6 human-approved GENERATED single-PNG
tile textures (256²) already sat on `main`, unwired. This change teaches the
terrain renderer to **stamp a whole generated texture** (scaled to tile size)
when a `TerrainType` maps to one, keeping the Kenney sheet-frame → solid-color
paths as ordered fallbacks. Wires **4 of the 6** art-ready types; the other 2
(DOOR, CORRIDOR) are deferred to WIRING follow-ups for correctness reasons
(below). 3🍎 engine change, full harness + review ledger.

Wired keys (each culled to ONE approved 256² variant in the manifest):

- `STONE_FLOOR` → `tile-stone-floor-v1-var-2`
- `STONE_WALL` → `tile-stone-wall-v1-var-5` (generated branch intentionally
  **bypasses** this type's Kenney autotile `frames` array — single texture)
- `BOSS_STAIR_FLOOR` → `tile-boss-staircase-floor-v2-var-10`
- `SAFE_ROOM_FLOOR` → `tile-safe-room-floor-v1-var-0`

## What shipped

- **`src/engine/sprites/tile-visuals.ts`** — added `readonly textureKey?: string`
  to `TileVisualDef`; set it on the 4 types above (sheetKey/frame/frames retained
  as fallback). DOOR + CORRIDOR intentionally untouched.
- **`src/engine/terrain-renderer.ts`** — the core change in `buildTerrainLayer`:
  a per-`textureKey` scale memo (`Map<string, number | null>` — `null` = missing
  texture OR unusable width, a deterministic fall-through), then a precedence
  branch `generated → Kenney sheet-frame → solid color`. Added `generatedCount`
  to `TerrainLayerResult` and the coverage logger.
- **`src/engine/scenes/MainGameScene.ts`** — stashes the `buildTerrainLayer`
  result counts on a private `terrainRenderSummary` field in `drawFloorTerrain()`
  and exposes a `getTerrainRenderSummary()` accessor (the observe seam).
- **`src/labs/main-scene-probe-lab/index.ts`** + **`tests/e2e/helpers/main-scene-probe.ts`**
  — probe-lab API + e2e wrapper reading the summary via the structural
  `MainSceneInternals` cast (no cross-layer import).
- **`tests/unit/terrain-renderer.test.ts`** (NEW, 9 tests) — deterministic unit
  test on the real `buildTerrainLayer` with a mock scene + mock RenderTexture.
- **`tests/e2e/terrain-generated-tiles.test.ts`** (NEW, 1 test) — boots the REAL
  MainGameScene via the probe lab.

## Observe-before-done (rule #10 / #15 — REAL artifact, not just a lab)

- **Before:** Floor-1 terrain rendered 100% Kenney placeholder frames —
  `generatedCount == 0`.
- **After:** the REAL booted `MainGameScene` reports
  `generatedCount > spriteCount > 0` (the e2e polls `getTerrainRenderSummary()`
  on the real scene, not a lab). Generated stone-floor/-wall dominate a
  room-heavy floor, so generated tiles are the majority.
- The unit test independently proves per-type stamp correctness: each of the 4
  types stamps its `textureKey` with `frame === undefined` at scale
  `tileSize / 256`; STONE_WALL bakes the generated texture (not its autotile
  frames); a type without a `textureKey`, a missing texture, and an invalid
  source width each fall through to the Kenney path; VOID fills color; the scale
  memo resolves exactly once per key; counts sum to total tiles.

`buildTerrainLayer` is a plain already-wired function (called from
`drawFloorTerrain()` and `set-piece-lab`), so no `check:wired-systems` concern.

## Descoped to F1-terrain WIRING follow-ups (art exists for all 6; w2 wires 4)

- **DOOR** — plan review caught a real double-render bug (rule #12, reflected to
  and endorsed by the orchestrator). `TerrainType.DOOR` renders FLOOR in terrain;
  `updateDoorOverlay()` (MainGameScene) already draws the door sprite dynamically
  with an open/closed animation at depth −19. Baking `tile-door-v1-var-0` into
  the terrain layer would double-render **and** kill the animation. Orchestrator
  default for the follow-up: NON-DESTRUCTIVE — wire the generated CLOSED art into
  `updateDoorOverlay`'s closed state; leave OPEN on the existing Kenney frame
  until/unless an open-door variant is generated (queued as OPTIONAL, don't block).
- **CORRIDOR** — 6 un-culled variants; needs a variant-cull pass first. Engine
  already supports it via the same `textureKey` seam once a single variant is
  chosen.

## Verification

- `npm run typecheck` — clean (exit 0).
- `npm run verify:fast` — ✅ 108 unit tests + guards green.
- Unit: `tests/unit/terrain-renderer.test.ts` — 9 passed.
- e2e: `tests/e2e/terrain-generated-tiles.test.ts` — 1 passed (real scene).
- Review ledger `docs/knowledge/review-ledgers/2026-07-08-w2-tile-stamp-engine.review-ledger.json`
  — valid 3🍎 ledger (plan_review + code_review both complete, clean).
- Headless Floor-1 gate: **not** run locally — this is a render-layer change that
  touches no `src/core` / `src/game/ai` / balance code and cannot affect the
  headless sim or win-rate; the required CI `test-headless` job still enforces it.

## Next steps

1. Land this PR (arm `--auto --squash` — gameplay-neutral engine change).
2. **DOOR overlay follow-up** — non-destructive closed-state wiring (see above).
3. **CORRIDOR variant-cull** follow-up, then wire via the same seam.
4. **F2 boss generation** (raccoon-boss + imp-boss) is sequenced AFTER w2 —
   generate → post sheets inline → NO auto-merge (maintainer eyeball). Confirm
   with the orchestrator first (asset_tracking bookkeeping shows "shipped", which
   conflicts with the live routing — trust the live routing).

## Apple estimate

Declared **3🍎**; actual **3🍎** — one engine file plus a thin observe seam and
two tests, with one real correctness finding (DOOR) that narrowed scope rather
than expanding it. Verdict: **recommended**, shipped clean.
