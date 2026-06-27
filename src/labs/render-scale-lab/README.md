# Render Scale Lab

Visual sandbox for the HiDPI **supersampling render scale** (`src/engine/render-scale.ts`).

## What it tests

The shipped game renders the fixed 1280×720 design space into a `design × S`
framebuffer (where `S` is an integer render scale) and zooms the UI camera by `S`
so text and pixel art stay crisp on high-density displays. This lab renders a
block of HUD-style text into a framebuffer sized `design × S` — mirroring the real
UI camera with `setOrigin(0, 0) + setZoom(S)` — so the crispness payoff is visible.

## How to use

```
npm run lab        # then open ?lab=render-scale-lab
```

- **Render scale** (lil-gui): toggle `S` between `1×` (the old blurry baseline)
  and `2×` (supersampled). On a HiDPI display the difference is obvious — `S=1`
  text is soft, `S=2` text is sharp.
- The on-canvas readout shows the device pixel ratio, the host CSS size, the
  render scale that would be **auto-detected at boot** for this display, and the
  live framebuffer (backing store) size.

## Related

- `src/engine/render-scale.ts` — `computeRenderScale` / `getRenderScale` / `resolveBootRenderScale`
- `src/bootstrap/floor1-game-config.ts` — sizes the real game `design × S`
- `src/engine/scenes/MainGameScene.ts` — world + UI camera supersample zoom
- ADR: `docs/knowledge/adr/` — HiDPI supersampling rendering decision
