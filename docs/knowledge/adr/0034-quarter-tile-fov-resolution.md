# ADR-0034: Quarter-tile FOV/fog-of-war resolution

**Date:** 2026-06-30  
**Status:** Accepted  
**Deciders:** Agent session (nalfeo-feat-quarter-tile-fov)

## Context

The FOV/fog-of-war system previously operated at full-tile granularity. The
`FloorMap.visible` bitmap had one entry per tile (`W × H`), so fog boundaries
were stairstepped at tile edges (typically 32-foot tiles). This produced
visually coarse fog transitions, especially noticeable on diagonal sight lines.

The system touches three architectural layers:

- `src/core/map/FloorMap.ts` — owns the visibility bitmap
- `src/core/systems/fovSystem.ts` — computes FOV each frame (rot-js)
- `src/engine/PhaserBridge.ts`, `src/engine/scenes/MainGameScene.ts`, `src/engine/HudMinimap.ts` — render consumers
- `src/game/ai/bt-ai-provider.ts` — AI perception consumer

## Decision

Run rot-js `RecursiveShadowcasting` at **2× tile resolution** (sub-tile
granularity) and store results in a `visible` bitmap sized `(2W) × (2H)`.

Key choices:

1. **4× bitmap size** — `visible` is now `Uint8Array` of length `4 × W × H`.
   For the typical 675×675 map, this is ~1.8 MB (acceptable).
2. **worldToSubTile** — maps world feet to sub-tile coords via
   `hx = floor(wx / (tileSizeFt/2))`.
3. **isVisible(tx, ty)** (tile-level) — returns `true` if **any** of the 4
   sub-tiles for `(tx, ty)` is lit. Backward compatible; used by minimap, AI,
   and weapon range checks.
4. **isVisibleSubtile(hx, hy)** — exact sub-tile query; used by the lighting
   overlay in `MainGameScene` for smooth fog edges.
5. **Entity visibility (PhaserBridge)** — uses tile-level `isVisible(tx, ty)`
   for consistency with weaponSystem and AI. Avoids the "invisible but
   targetable" paradox that would arise from using sub-tile granularity here.
6. **Fog overlay (MainGameScene)** — uses `isVisibleSubtile` for the 2×
   precision benefit, giving smoother fog rendering without affecting gameplay.
7. **setVisible(hx, hy)** — now takes sub-tile coordinates; callers multiply
   tile coords by 2 for the TL quadrant.

## Consequences

### Positive

- Visually smoother fog/FOV boundaries — diagonal edges step at half-tile
  (16-foot) increments instead of full-tile.
- No change to gameplay semantics: tile is considered "visible" if any quadrant
  is lit, which is at least as permissive as before.
- All consumer APIs (isVisible, isVisibleAt) remain on FloorMap.

### Negative / Risks

- Tile centers fall exactly on sub-tile seams (with tileSizeFt=4, center at
  2.0 → hx=1, the boundary between sub-tiles 0 and 1). Minor asymmetry;
  accepted as non-blocking since both adjacent sub-tiles are typically co-lit.
- HudMinimap iterates all tiles calling `isVisible(tx, ty)` (4 reads each).
  For 675×675: ~1.82M reads/frame. Acceptable per performance review.
- Memory: 4× bitmap. ~1.8 MB for max map. Acceptable.

### Alternatives Considered

- **8× (quarter-tile on both axes)**: Further smoothing but 16× memory and
  CPU impact — rejected.
- **Per-entity sub-tile visibility in PhaserBridge**: Considered but creates a
  "hidden but targetable" inconsistency with the weapon/AI tile-level checks —
  rejected; fog rendering uses sub-tile but entity hide/show stays tile-level.
- **Smooth fog via shader/texture blur**: Would require a separate render pass;
  the sub-tile bitmap approach achieves similar smoothing at lower complexity.
