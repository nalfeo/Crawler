# ADR 0017: Feet as the single internal spatial unit

## Status

Accepted

## Date

2026-06-23

## Estimated Complexity

🍎 x 5 — touches every non-rendering layer (core/game/shared), the entire
rendering boundary (engine), all spatial data files, and ~160 test files; no new
runtime system but a pervasive unit inversion with high blast radius.

## Context

ADR-era migration `2026-06-08-px-to-feet` made _authored_ design distances
(weapon ranges, tuning, system constants) feet, but **ECS stores still held
pixels**: `ftToPx()`/`pxToFt()` converted feet → pixels at every system
boundary (`PIXELS_PER_FOOT = 8`). This left two units coexisting internally —
pixels in the stores, feet in the data — forcing conversions throughout
`src/core` and `src/game`, and making it easy to mix units. Pixels are a
_rendering_ concern (they depend on zoom and screen density); the simulation
should not care about them.

## Decision

Invert the convention so **feet (with decimal precision) is the single internal
spatial unit** for all non-rendering layers (`src/core`, `src/game`,
`src/shared`). Pixels exist **only** in `src/engine` (the Phaser rendering
layer), which scales feet → pixels at draw time.

- `PIXELS_PER_FOOT = 8` is reframed as a **render-only** scale. `ftToPx()` /
  `pxToFt()` are documented as rendering-layer-only and are no longer used in
  core/game/shared. `formatFeet()` now takes feet directly.
- All ECS stores (Position, Velocity, sprite width/height, beam/melee reach,
  AoE radius, knockback, etc.) hold feet. Numerically this is the previous
  pixel value ÷ 8, preserving decimals (no rounding of positions).
- Tile size is expressed in feet: `tileSizePx (32)` → `tileSizeFt (4)`.
  `FloorMap.widthPx/heightPx` → `widthFt/heightFt`; `pixelToTile`/`tileToPixel`
  → `worldToTile`/`tileToWorld`. Map dimensions in _tiles_ are unchanged.
- Spatial-hash `DEFAULT_CELL_SIZE` 64 px → 8 ft. Cell **indices** are still
  integer buckets (`Math.floor(pos / cellSize)`), which is correct.
- Arena bounds are expressed in feet (`ARENA.WIDTH_FT = 160`,
  `HEIGHT_FT = 90`); the render canvas (`GAME.WIDTH/HEIGHT = 1280×720`) stays in
  pixels.
- The rendering layer is the **only** conversion boundary. The world stays in
  pixel-space at draw time: world-state spatial reads (entity positions,
  beam/melee/AoE lengths, marker radii, gore/floater positions, follow-origin)
  are multiplied by `PIXELS_PER_FOOT` via `ftToPx()` where they enter Phaser;
  terrain bakes at `tileSizeFt * PIXELS_PER_FOOT` px per tile. Art texture
  scales and line/stroke widths stay in pixels and are left untouched, so visual
  output is unchanged.

## Consequences

### Positive

- One spatial unit internally. No more `ftToPx`/`pxToFt` churn at system
  boundaries; design data flows straight into stores.
- Decimal precision preserved end-to-end (positions are never rounded to whole
  pixels in the sim).
- Pixels are fully isolated to `src/engine`; the renderer is the single place
  that knows about screen scale, matching the bridge-pattern architecture.

### Negative

- Large mechanical diff, especially across tests (every ECS spatial fixture and
  assertion divided by 8).

### Risks

- Missed pixel literals in the rendering layer would mis-scale individual
  objects. Mitigated by isolating the conversion to clearly-marked `ftToPx()`
  reads and verifying via the full test suite plus the lab gate.
- A test "fixed" by matching output rather than applying the ÷8 rule could mask
  a real bug. Mitigated by applying a strict ÷8 transformation and flagging any
  assertion that does not fit it.

## Alternatives Considered

- **Camera-zoom scaling** (fold `PIXELS_PER_FOOT` into the world camera zoom so
  feet positions render directly): rejected because a uniform camera/container
  scale also magnifies texture art sizes and `lineStyle`/`setStrokeStyle`
  widths (which remain authored in pixels), making every sprite and stroke 8×
  too large/thick and requiring compensating `/PIXELS_PER_FOOT` at more sites
  than the position-scaling approach.
- **Keep pixels internal** (status quo): rejected — it perpetuates dual units
  and per-boundary conversions, the exact problem this ADR removes.
