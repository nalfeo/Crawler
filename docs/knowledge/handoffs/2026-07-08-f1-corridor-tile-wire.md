# Handoff — Wire generated corridor tile texture (F1 terrain 5/6)

Date: 2026-07-08
Persona: Graphics/Content Designer
Apple estimate: 1🍎 (actual: 1🍎)

## Systems touched

sprite-pipeline, mapgen

## Summary

Follow-up to the w2 tile-stamp engine change (PR #927). CORRIDOR was the 5th of
six Floor-1 terrain types; w2 wired the first four (stone-floor/-wall,
boss-staircase, safe-room). This wires CORRIDOR's approved generated
single-texture (`tile-corridor-v1-var-10`) through the **existing** `textureKey`
seam in `buildTerrainLayer` — a pure data change, **zero engine change**. F1
terrain art wiring goes **4/6 → 5/6**. DOOR (6/6) is the remaining follow-up (a
real `updateDoorOverlay` engine change, tracked separately).

## What changed

- `src/engine/sprites/tile-visuals.ts` — added `textureKey:
'tile-corridor-v1-var-10'` to the `CORRIDOR` `TileVisualDef`. The RPG-pack
  cobblestone frame stays as the load-failure fallback.
- `tests/unit/terrain-renderer.test.ts` — added two CORRIDOR cases (generated
  stamp wins when loaded; Kenney fallback when not loaded); repurposed the two
  tests that previously used CORRIDOR as the "unwired" example to `CAVE_FLOOR`
  (genuinely Kenney-only). 9 → 11 tests, all green.

## Variant selection (6 → 1 cull)

Eyeballed all six generated corridor variants (var-2/-4/-8/-10/-12/-14, all
256² single-cell full-bleed). Picked **var-10** as the cleanest, most
uniformly-tileable — the others carry strong asymmetric cracks (var-4/-8) or a
yellow discolouration blob (var-12) that would read as an obvious repeat across
a multi-tile passage. All six predate the slicer fix #919, but the right-edge
chop #919 fixed only affects multi-cell sheets with commanded≠drawn grids; a
single-cell tile never triggers it — verified visually (no chop, full-bleed).

The five unused variants remain in the manifest (unreferenced manifest entries
are already normal, e.g. multiple stone-floor variants). A manifest trim is an
optional catalog-hygiene follow-up, intentionally not bundled into a wiring PR.

## Observe before done (rule #10/#15 — real artifact, not just a lab)

CORRIDOR rides the **identical** generated→Kenney→color precedence path already
proven in the real `MainGameScene` for the four w2 types:

- **Real engine function**: `tests/unit/terrain-renderer.test.ts` drives the
  REAL `buildTerrainLayer` (the same function `drawFloorTerrain()` calls in
  `MainGameScene.create()`). Before: CORRIDOR had no `textureKey` → RPG frame 8
  (counted `spriteCount`). After: with the texture loaded, CORRIDOR stamps the
  generated whole-texture at `__BASE` scaled `tileSize/256` (counted
  `generatedCount`); with it not loaded, it falls back to the RPG frame.
- **Real scene e2e**: `tests/e2e/terrain-generated-tiles.test.ts` boots the real
  `MainGameScene` and asserts `generatedCount > spriteCount > 0` via
  `getTerrainRenderSummary()`. Corridors are common on F1, so wiring CORRIDOR
  strictly raises the generated tile share in the booted scene (assertion still
  holds, now stronger). No new probe seam needed — the w2 seam already exposes
  the counts.

## Validation

- `npx vitest run tests/unit/terrain-renderer.test.ts` → 11/11 pass.
- `npm run verify:fast` → green.
- `npm run verify` → green (incl. lab gate + build).
- Headless Floor-1 Gate deferred to CI (render-layer change is sim-neutral; a
  render change cannot affect the headless sim, which does no rendering).

## Follow-ups (unchanged, tracked by orchestrator)

- **DOOR (6/6)** — wire generated `tile-door-v1-var-0` (verified clean closed
  door) into `updateDoorOverlay`'s CLOSED branch only; leave the Kenney open
  frame until an open-door variant exists (orchestrator's non-destructive
  default). Real engine change → its own 3🍎 plan+code review harness.
- **Corridor manifest trim** — optional catalog hygiene (drop the 5 unused
  variants); not gameplay-affecting.
- **Open-door variant** — OPTIONAL asset generation, queued by orchestrator.
