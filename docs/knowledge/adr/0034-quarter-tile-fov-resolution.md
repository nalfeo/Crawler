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

## Amendment (2026-07-02): dynamic granularity + discovered-terrain memory

**Session:** nalfeo-reimagined-invention · **Status:** Accepted (extends, does not
supersede, the decision above).

Two changes were made to the FOV/fog-of-war system. **The default is unchanged:**
FOV still runs at 2× (quarter-tile, 16px cells) out of the box, so the decision
and consequences above remain the shipped baseline.

### 1. `subFactor` is now a runtime-tunable integer (was hardcoded ×2)

`FloorMap` gained an integer `subFactor` (default `DEFAULT_FOV_SUB_FACTOR = 2`,
max `MAX_FOV_SUB_FACTOR = 8`) replacing the hardcoded ×2. `setSubFactor(n)`
reallocates the `visible`/`discovered` bitmaps (resetting discovered memory **by
design** — every caller immediately recomputes FOV and rebuilds the light field,
so no stale/black frame results); `fovSystem` scales its radius and `lightPasses`
mapping by the factor, so vision **range in feet is unchanged** at any factor. The engine bridges the pixel-facing `cellPx` the lab UI speaks to the
core integer (`src/engine/fov/fov-config.ts`), and the AI-runner lab exposes a
"FOV" folder (preset buttons 32/16/8/4px + a sub-factor slider) with a Perf
subfolder, mirroring the existing lighting-config pattern.

**Why this does not reopen the gameplay-consistency risk:** the shipped default is
frozen at `subFactor = 2`, byte-identical to the pre-amendment behavior
(`setSubFactor(2)` is an early-return no-op), so **shipped gameplay is unchanged**;
the finer factors (3–8) are **lab-only** opt-in. `isVisible(tx, ty)` ORs a tile's
sub-tiles via an O(1) tile-level cache, so tile-level queries (AI perception,
weapon range, entity hide/show, minimap) stay O(1) regardless of factor and — for
tiles strictly **inside** the vision radius and unoccluded — return the **same**
result at every factor. Tile visibility can differ by **≈1 tile at boundaries**
(the circular vision-radius edge and shadow/occlusion edges), because those edges
are rasterized on the finer sub-grid: a finer factor resolves the radius edge
tighter (monotonically fewer radius-ring tiles) and the shadow wedges differently.
This is the granularity knob working as intended, is confined to lab-only factors,
and never affects the frozen default — so the "hidden but targetable" paradox the
original ADR guards against cannot arise in the shipped game. See
`tests/ecs/fov-system.test.ts` (the interior-identical test plus the radius- and
occlusion-boundary divergence pins) for the exact, tested guarantees. Only the fog
_visuals_ (`isVisibleSubtile`) get finer for gameplay purposes.

**The "8× rejected" alternative above is revised, not reversed.** 8× (4px cells)
is now selectable **at runtime only**; it is **not** the default. The original
"16× memory and CPU" objection holds as a _ratio_ but is trivial in absolute
terms on a real map — measured on the actual 240×140 floor-1 map, radius 25 tiles:

| cell | factor      | bitmap  | FOV compute/frame |
| ---- | ----------- | ------- | ----------------- |
| 32px | 1           | 0.03 MB | 0.010 ms          |
| 16px | 2 (default) | 0.13 MB | 0.030 ms          |
| 8px  | 4           | 0.54 MB | 0.069 ms          |
| 4px  | 8           | 2.15 MB | 0.260 ms          |

Even the finest setting costs <0.3 ms/frame and ~2 MB, so keeping the finer tiers
as opt-in (rather than forbidden) is safe; the default stays 2× purely to avoid
changing shipped behavior. Per-frame FOV cost is surfaced as engine-only EWMA
telemetry (`runFovSystem` hook on `SimulationStepHooks`) so the knob is
measurable in the lab.

### 2. Discovered-terrain memory (dim, not black) — default ON

`FloorMap` gained a persistent `discovered` bitmap (set by `fovSystem` alongside
`visible`; it persists for the whole floor and is otherwise cleared only on floor
change — the one exception is `setSubFactor()` re-bucketing the fog buffers, which
resets it **by design** as described above, since every caller immediately
recomputes FOV). `computeLightField` renders
discovered-but-not-currently-visible cells at a dim `discoveredLight`
(`LightingConfig.discoveredLight`, default `0.05`) instead of full black. The
value is clamped to `ambient` so remembered terrain is never brighter than the
dimmest visible cell, and `0` reproduces the legacy full-black behavior. This
gives explored areas a "memory" on both the fog overlay and minimap, matching how
players expect previously-seen terrain to persist.

### Consequences of the amendment

- **No default behavior change**: 2× quarter-tile fog remains the shipped
  resolution; discovered-darkening is the only visible default change and is
  purely additive (previously-black explored cells now render dim).
- **New single source of truth for "discovered"**: `FloorMap.discovered`
  (tile-level O(1) cache mirrors it), consumed by both lighting and minimap.
- **Lab-testable**: FOV granularity + discovered dimming are live-tunable in the
  AI-runner lab exactly like lighting, including per-frame perf readout.
