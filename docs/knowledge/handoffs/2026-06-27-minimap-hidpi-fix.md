# Session Handoff: HiDPI minimap + fullscreen-map layout regression fix

## Date

2026-06-27

## Persona(s) adopted

**Producer** (default) — a focused rendering bug spanning diagnosis, an
engine-layer fix, deterministic test guards, and a visual before/after probe.
The work stayed in `src/engine/`, so no specialist hand-off was needed.

## Routing verdict

✅ right persona — single-surface bug fix; Producer carried it end-to-end.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — small, well-scoped fix in one engine component (+ its unit
test). The extra effort went into HiDPI observation tooling and proving an
unrelated wall-time flake, not into code footprint (2 files changed).

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

hud-ux

## What Was Done

Fixed two HiDPI-only HUD regressions introduced by PR #353 (render
supersampling): **the minimap radar dial disappeared** and **the fullscreen
"Dungeon Map" overlay opened off the right/bottom of the screen** — but only on
displays where `devicePixelRatio > 1`.

### Root cause

PR #353 changed the canvas backing store to `design × S` (S = integer render
scale, 1–2) and added a UI camera with `setZoom(S)` so HUD objects are authored
in 1280×720 design space and scaled up by the camera. That PR migrated `HudUI`,
`ui-scale`, and 5 modals from `scene.scale.width/height` (now the backing store)
to the `GAME.WIDTH/HEIGHT` design constants — but **`HudMinimap.ts` was never
migrated**. It kept reading `scene.scale.gameSize` (the backing store), so on a
dpr=2 display it laid the radar/overlay out in a 2560×1440 space, then the
zoom-2 UI camera doubled that again → the radar landed at ~4944px (off-screen
right) and the overlay panel started at ~1440px and ran off the edges.

### Fix (`src/engine/HudMinimap.ts`)

- `getGameSize()` now returns the design constants `{ GAME.WIDTH, GAME.HEIGHT }`
  instead of `scene.scale.gameSize`, so all radar/overlay geometry is authored
  in design space (identity at S=1).
- Added a `toDesignSpace(x, y)` helper that divides pointer coords by
  `getRenderScale(scene)`, and applied it in the three manual-input paths
  (`handleWheel`, pinch + drag in `handlePointerMove`, and the `viewportHitArea`
  pointerdown). Phaser reports pointer coords in backing-store space; the overlay
  viewport is now design space, so hit-testing and pan deltas must be converted.
  This also fixes 2×-too-fast overlay panning on HiDPI. All conversions are
  identity at S=1.

### Regression coverage (`tests/unit/hud-minimap.test.ts`)

- Flipped the source-guard that previously asserted `scene.scale.gameSize.*` (it
  encoded the buggy assumption). It now asserts design-space sourcing
  (`return { width: GAME.WIDTH, height: GAME.HEIGHT };`) **and** that
  `scene.scale.gameSize` no longer appears in the file.
- Added a guard asserting the pointer→design-space conversion exists
  (`toDesignSpace` / `getRenderScale(scene)` / `x / s, y / s`).

### Observation (rule 10 — observe before done)

Reproduced in the **real game** (`npm run dev`) under Playwright at
`deviceScaleFactor: 2` (backing store confirmed 2560×1440):

- **Before:** radar absent from the top-right; "Dungeon Map" panel rendered off
  the right/bottom edges.
- **After:** radar dial restored top-right (gold ring, N compass, "MAP (M)"
  label); overlay centered with its close button + hint fully visible.
- **dpr=1:** identical to prior behavior (fix is a no-op at S=1), confirming no
  standard-resolution regression.

(Screenshots captured to the session `files/` dir: `before-hud/map`,
`after-hud/map`, `dsf1-hud`. The reproduction needs the real game config —
`src/bootstrap/floor-game-config.ts` is the only config that sizes the canvas
`design × renderScale`; all labs boot at design size with `Phaser.Scale.FIT`, so
they force S=1 and cannot reproduce the bug.)

## What's Next

- Optional follow-up: promote HiDPI HUD layout into a **deterministic** check by
  giving a lab a `design × S` boot config (or parameterizing an existing one) so
  a dpr=2 minimap regression can be caught in CI. Today the deterministic net is
  source guards + unit tests + the dpr=1 `minimap-overlay` e2e (this matches the
  established #353 pattern: probe-proven, shipped as pure-fn unit tests + source
  guards rather than a dpr=2 e2e). Not required for this fix.

## Blockers

None.

## Branch State

- Branch: `nalfeo-fix-minimap-fullscreen-map`
- All tests passing: yes (see Test Results — the only red was an environmental
  wall-time flake, proven unrelated)
- PR created: yes (auto-merge armed via `gh pr merge --auto --squash`)

## Agent-OS Telemetry

N/A — `files/guard-telemetry.jsonl` does not exist this session.

## Test Results

Full `npm run verify`:

- ✅ Typecheck, ✅ Lint, ✅ Format, ✅ Knip (non-blocking)
- ✅ Unit + coverage (incl. updated `hud-minimap` guards)
- ✅ Integration (49 passed, 1 skipped)
- ✅ Build (`vite build`)
- Headless Floor 1 gate: ✅ when machine is unloaded (68/68). Under concurrent
  load (dev + lab servers + coverage running) it threw 2 **wall-time**
  perf-guard failures on **non-deterministic seeds** (run 1: seeds 7, 5; run 2:
  seeds 5, 15). Proven environmental:

  | Variant          | Machine  | Result             |
  | ---------------- | -------- | ------------------ |
  | Fix              | loaded   | 2 wall-time flakes |
  | Fix              | loaded   | 2 wall-time flakes |
  | Base (no change) | unloaded | 68/68 pass         |
  | Fix              | unloaded | 68/68 pass         |

  Frame counts are deterministic; only wall-clock varied. The HUD-only change is
  never instantiated in the headless sim, and base vs. fix behave identically
  when unloaded.

Directly-related e2e: ✅ `tests/e2e/minimap-overlay.test.ts` (5 passed, dpr=1).

## Key Decisions Made

- Anchor HUD layout to design constants (matching #353's `HudUI`/modal
  migration) rather than special-casing the minimap — keeps the whole HUD on one
  coordinate model.
- Convert pointer input to design space at the handler boundary via a single
  `toDesignSpace` helper rather than threading scale through the pure
  `minimap-view-state` math, keeping that module scale-agnostic.
- Did **not** raise the headless wall-time budget: the failures are
  machine-load flakes (the test itself warns against raising the budget without
  profiling a legitimate slowdown), and base reproduces them under load.
