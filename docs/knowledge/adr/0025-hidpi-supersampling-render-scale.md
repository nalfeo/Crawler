# ADR-0025: HiDPI Supersampling Render Scale for Crisp Text

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 4 — multi-system rendering change spanning the boot game config, both scene
cameras, the `ui-scale` text-resolution model, and five modal components; adds a
pure `render-scale` module with unit tests and a new `render-scale-lab`.

## Context

HUD and in-world text were blurry on high-resolution (HiDPI) displays. PR #342
gave every persistent `Text` object a device-aware Phaser `resolution`, which is
necessary but **insufficient**, because of how the game is rendered:

- The game runs `pixelArt: true` + `Phaser.Scale.FIT` against a fixed **1280×720
  design space**.
- Phaser 4's `ScaleManager` sizes the canvas **backing store** to the design size
  (1280×720) with **no `devicePixelRatio` multiply**, then `FIT` nearest-neighbour
  **upscales** that backing store to the displayed size.
- A Playwright probe at `devicePixelRatio: 2` confirmed the backing store was
  **1280×720** stretched across ~2560×1440 physical pixels — every glyph is
  rasterised at 720p and then magnified ~2×.

So **all** detail is capped at 720p before upscaling. Per-`Text` `resolution` only
sharpens anti-aliasing _within_ that 720p framebuffer; it cannot add the detail
the display can show. The framebuffer itself must carry more pixels.

A second, latent problem surfaced while investigating: several components read
`scene.scale.width/height` as if it were the **design** size (1280×720). Once the
framebuffer is sized larger than the design space, `scale.width` is the
framebuffer size, so those reads conflate "design space" with "backing store" and
would mislay the HUD/modals.

## Decision

Render the whole game into a **`design × S` framebuffer**, where `S` is an integer
**render scale**, while preserving the 1280×720 **design space** for all gameplay,
layout, and input via camera zoom. On a 1× display at/below the design size,
`S === 1` and the entire mechanism is a **no-op** (CI/e2e run at
`devicePixelRatio: 1`, so they are unaffected).

### `render-scale` module (pure, `src/engine/render-scale.ts`)

- `computeRenderScale(cssW, cssH, dpr, opts?)` =
  `clamp(round(min(cssW/designW, cssH/designH) × dpr), 1, MAX_RENDER_SCALE)`.
  `min(cssW/designW, cssH/designH)` is the `FIT` magnification (CSS px per design
  px); multiplying by `dpr` converts to **physical** px per design px — the detail
  the framebuffer must carry. Rounding keeps the framebuffer an **integer**
  multiple of the design size (required for crisp pixel-art scaling).
- `MAX_RENDER_SCALE = 2` caps the framebuffer at 2560×1440 (4× the 720p fill
  rate), covering the common `dpr: 2` case and large 1× displays shown at 2×
  magnification. Denser displays are clamped here to bound GPU cost.
- `getRenderScale(scene)` = `round(scene.scale.width / GAME.WIDTH)` (≥ 1) recovers
  `S` live from the booted game size.
- `resolveBootRenderScale(parent)` reads the parent container's laid-out
  `clientWidth/Height` (falling back to the window, then the design size) so the
  canvas can be sized **before** the Phaser game is constructed.

Engine layer only — Phaser types allowed, no imports from core/game/labs.

### Framebuffer sizing (`src/bootstrap/floor1-game-config.ts`)

`createFloor1GameConfig` calls `resolveBootRenderScale(parent)` and sizes the game
`width: GAME.WIDTH × S, height: GAME.HEIGHT × S`.

### Cameras (`src/engine/scenes/MainGameScene.ts`)

- **World (main) camera**: zoom `CAMERA.BASE_ZOOM × S` and `zoomTo(... × S)`.
  Width is `design × S` and zoom is `BASE_ZOOM × S`, so `displayWidth =
width / zoom = design / BASE_ZOOM` is **unchanged** — the field of view and
  `centerOn(player)` framing are identical; only the pixel density increases.
  `S` is always an integer, so `zoomX` stays integer and Phaser keeps
  `renderRoundPixels` on → crisp pixel art.
- **UI camera** (`ensureUiCamera`): viewport sized to the full `design × S`
  framebuffer, **`setOrigin(0, 0)` + `setZoom(S)`**. HUD/modals use
  `setScrollFactor(0)`; with Phaser's camera matrix
  `transform(p) = zoom × (p − originX) + originX` and scroll 0, only
  `originX = 0` maps a design-space coordinate `dx` to framebuffer `dx × S` (a
  top-left scale-up that fills the framebuffer). The default origin `0.5` would
  push the corners off-screen — a scroll offset does **not** work on
  scrollFactor-0 objects, so the origin/zoom approach is required.

### Design-space migration

Components that lay out against the design space now read `GAME.WIDTH/HEIGHT`
instead of `scene.scale.width/height`: `HudUI`, `ui-scale`
(`getUiScale`/`fitUiScale`), and the `DialogueBox`, `EquipmentUI`, `InventoryUI`,
`LevelUpUI`, and `ModalPickerUI` modals. **`InputCapture` keeps
`scene.scale.width`** — there it correctly means true game/world space.

### Text resolution model (`src/engine/ui-scale.ts`)

`computeTextResolution` is rebuilt from the old FIT-magnification formula to
`round(S × uiScale)` (clamped `[1, MAX_TEXT_RESOLUTION = 4]`), and modals base
their text resolution on `getRenderScale(scene)` rather than raw
`devicePixelRatio`. This ties text detail to the framebuffer that actually exists,
so on a 1080p `dpr: 1` monitor shown at 2× magnification text is rendered at `S=2`
(crisp) instead of `dpr=1` (blurry).

### `render-scale-lab`

A new lab (`src/labs/render-scale-lab/`) renders HUD-style sample text into a
`design × S` framebuffer with a lil-gui toggle for `S` (1 vs 2) and a live readout
of `devicePixelRatio`, host CSS size, auto-detected boot scale, and backing-store
size — making the supersampling effect directly observable.

## Consequences

### Positive

- Text and pixel art are sharp on HiDPI displays: the framebuffer carries the
  display's detail instead of upscaling a 720p image.
- All gameplay, layout, and input stay in the fixed 1280×720 design space — no
  call site needs to reason about physical pixels.
- Zero cost and zero behavioural change on 1× / design-size displays (`S = 1`),
  so CI, e2e, and low-DPI machines are unaffected.
- The render scale is a single pure function with unit tests, and the lab makes
  the effect reproducible without a HiDPI machine.

### Negative

- HiDPI machines pay up to 4× fill rate (2560×1440 vs 1280×720). Bounded by
  `MAX_RENDER_SCALE = 2`.
- "Design space vs backing store" is now a real distinction contributors must
  respect: lay out against `GAME.WIDTH/HEIGHT`, not `scene.scale.width`.

### Risks

- **V1 computes `S` once at boot.** Dragging the window to a different-DPI monitor
  does not re-derive `S` until reload. Acceptable for now; documented as future
  work (recompute on a `dpr`-change `matchMedia` listener and resize the game).
- The UI-camera mapping depends on Phaser 4's `setOrigin(0,0) + setZoom(S)`
  semantics for scrollFactor-0 objects. A Phaser camera-matrix change would
  require revisiting `ensureUiCamera`. Low risk; pinned Phaser version.

## Alternatives Considered

1. **Per-`Text` `resolution` only (PR #342).** Sharpens AA within the 720p
   framebuffer but cannot exceed 720p of real detail. Kept as a complementary
   layer (text resolution now tracks `S`), but insufficient alone. Rejected as the
   complete fix.
2. **Multiply the canvas backing store by `devicePixelRatio` directly** (bypassing
   the design space). Would desynchronise design-space layout/input math from the
   backing store and break `pixelArt` integer scaling on fractional `dpr`.
   Rejected in favour of an integer render scale with camera zoom.
3. **Scroll-offset the UI camera instead of `setOrigin(0,0)`.** Does not work:
   HUD/modals are `setScrollFactor(0)`, so camera scroll is ignored; only the
   origin/zoom transform scales them. Rejected (proven via the Phaser camera
   matrix).
4. **Unbounded `S = round(fitMag × dpr)`.** Sharpest possible, but a `dpr: 3`
   phone or 8K panel would allocate an enormous framebuffer. Capped at
   `MAX_RENDER_SCALE = 2`; the residual is still far sharper than the 720p
   baseline.
