# 2026-06-26 HiDPI supersampling for crisp text

## Session summary

Follow-up to the merged per-`Text` `resolution` fix (PR #342), which was necessary
but **insufficient**: Phaser 4 sizes the canvas backing store to the fixed
1280×720 design size with no `devicePixelRatio` multiply, then `Scale.FIT`
nearest-neighbour **upscales** it — so all detail was capped at 720p before
upscaling. This session renders the whole game into a **`design × S` framebuffer**
(`S` = integer render scale) while preserving the 1280×720 design space via camera
zoom, so text and pixel art are crisp on HiDPI displays. On a 1× / design-size
display `S === 1` → complete no-op.

See **ADR-0025** (`docs/knowledge/adr/0025-hidpi-supersampling-render-scale.md`).

**Apple estimate:** 🍎🍎🍎🍎 (4) declared up front · **actual:** 🍎🍎🍎🍎 (4) ·
verdict 🎯 exact — genuinely multi-system (boot config + 2 cameras + text model +
5 modals + HudUI) with an ADR + new lab, but no surprises (probe-proven early).

## Root cause (proven via Playwright probe at dpr=2)

- Game runs `pixelArt: true` + `Scale.FIT`, design space 1280×720.
- Phaser 4 `ScaleManager` sets the canvas **backing store** = design size (1280×720)
  with **no dpr multiply**; `FIT` then upscales to the display.
- Probe at `devicePixelRatio: 2`: backing store **1280×720** stretched across
  ~2560×1440 physical px → every glyph rasterised at 720p, then magnified ~2×.
- Per-`Text` `resolution` (PR #342) only sharpens AA _within_ 720p; the framebuffer
  itself must carry more pixels.

## The fix (supersampling render scale)

### `src/engine/render-scale.ts` (new, pure)

- `computeRenderScale(cssW, cssH, dpr, opts?)` =
  `clamp(round(min(cssW/designW, cssH/designH) × dpr), 1, MAX_RENDER_SCALE=2)`.
- `getRenderScale(scene)` = `round(scene.scale.width / GAME.WIDTH)` (≥1) — recovers
  the live `S` from the booted game size.
- `resolveBootRenderScale(parent)` reads the parent's laid-out CSS size; returns 1
  in non-DOM (headless) contexts.
- `readDevicePixelRatio()`, `MAX_RENDER_SCALE=2`.

### Framebuffer + cameras

- `src/bootstrap/floor1-game-config.ts`: game sized `GAME.WIDTH×S × GAME.HEIGHT×S`.
- `src/engine/scenes/MainGameScene.ts`: world camera `setZoom(BASE_ZOOM × S)` and
  `zoomTo(... × S)` (FOV unchanged: `displayWidth = width/zoom = design/BASE_ZOOM`);
  UI camera viewport `= design×S`, **`setOrigin(0, 0)` + `setZoom(S)`**. Because
  HUD/modals use `setScrollFactor(0)`, the Phaser camera matrix
  `transform(p) = zoom×(p − originX) + originX` (scroll 0) requires `originX=0` to
  map design `dx` → framebuffer `dx×S` from the top-left. A scroll offset does
  **not** work on scrollFactor-0 objects — origin/zoom is mandatory.

### Design-space migration

`scene.scale.width/height` (now the backing store) replaced with
`GAME.WIDTH/HEIGHT` in: `HudUI`, `ui-scale` (`getUiScale`/`fitUiScale`), and the
`DialogueBox`/`EquipmentUI`/`InventoryUI`/`LevelUpUI`/`ModalPickerUI` modals.
**`InputCapture` keeps `scene.scale.width`** (true world space — left as-is).

### Text resolution model

`computeTextResolution` rebuilt to `round(S × uiScale)` (clamped `[1,4]`); the 5
modals base text resolution on `getRenderScale(scene)` instead of raw
`devicePixelRatio` (so a 1080p dpr=1 monitor at 2× magnification renders at S=2,
not 1).

### Lab + ADR

- `src/labs/render-scale-lab/` (new, registered in `src/lab-main.ts`): renders
  HUD-style text into a `design×S` framebuffer with a lil-gui `S` toggle (1 vs 2)
  - live readout (dpr, host CSS size, auto-detected boot scale, backing store).
- `docs/knowledge/adr/0025-hidpi-supersampling-render-scale.md`.

## Validation

- **Probe (real game), dpr=2:** backing store **2560×1440** (was 1280×720); text
  crisp; HUD corners + centered loadout modal correctly positioned. dpr=1:
  **1280×720** (S=1 no-op confirmed).
- **Probe (render-scale-lab):** S=2 → 2560×1440, S=1 → 1280×720; toggle rebuilds
  with **zero console errors**.
- `npm run verify:fast` → **PASS**. `npm run verify`: typecheck, ESLint, Prettier,
  knip, unit + coverage, integration, **vite build** all **PASS**.
- `npm run test:e2e`: `hud-overlap-visual` (HUD layout/camera), inventory equipment
  paper-doll, level-up steppers, minimap all **PASS**.
- **Two environmental flakes — NOT regressions (proven):**
  1. **Headless wall-clock guard** (`floor1-completion.test.ts:214`): tripped on a
     _different seed each run_ (run 1 = seed 3 · bow 48.5s; run 2 = seed 7 ·
     baseball-bat 32.6s) while **frame counts are deterministic** (15804, 19506)
     and **every game-time budget passes**. The machine was running ~80 node
     processes from other shared sessions. Headless never imports `src/engine/`
     and boots with no `window` (S=1), so this engine change cannot affect it.
     Did **not** raise the budget (no real regression to profile).
  2. **e2e `minimap-overlay`** failed once on a `page.goto` **networkidle timeout**
     (server startup under concurrent load), then **passed 5/5 in isolation**.
     `hud-overlap-visual` loads a lab + HudUI in the same run and passed, so the
     HudUI change is not at fault.

## Next steps / open questions

- **V1 computes `S` once at boot.** Dragging the window to a different-DPI monitor
  won't re-derive `S` until reload — documented in ADR-0025 as future work
  (recompute on a `matchMedia` dpr-change listener + resize the game).
- Labs other than `render-scale-lab` boot at the design size (`S=1`), so they are
  unaffected; only the real game (`createFloor1GameConfig`) supersamples.
- PR #342 (per-text fix) is **merged**; this is a **separate new PR** rebased onto
  current `main`.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "allow": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```

## Rebase + review follow-up (2026-06-27, shepherd)

The original session went idle/archived before review threads landed, so the PR
shepherd finished it directly in a temp worktree (rebased onto current `main`,
trivial `src/lab-main.ts` conflict resolved by keeping both `spawnanim-lab` and
`render-scale-lab` registrations).

Copilot Code Review opened 5 threads; all addressed (real fixes, not hand-waves):

- **Thread E — substantive code (HUD text softening).** The new
  `round(getRenderScale × uiScale)` dropped the sub-`S` FIT-magnification term and
  switched `ceil → round`, so in the residual band (effective mag ~1–1.5 → `S=1`)
  HUD text fell back to `round(1.x)=1`, re-blurring text that #342 kept crisp at
  `ceil(1.x)=2`. Fix: added `computeOnScreenScale` (pure, continuous
  `fitMagnification × dpr`) + `getOnScreenScale(scene)` (reads
  `scale.displaySize`) in `render-scale.ts`; `computeTextResolution` is now
  `ceil(onScreenScale × uiScale)` and `getTextResolution` feeds it the continuous
  on-screen scale. Restores #342's net `ceil(continuous-mag × dpr)` behaviour as a
  complementary layer. New unit coverage in `render-scale.test.ts` +
  `ui-scale.test.ts` (incl. explicit S=1-band crispness asserts:
  `computeTextResolution(1.25,1)===2`, `(1.2,1)===2`). e2e-safe: CI runs at
  `dpr=1` near design size (mag≈1 → `ceil(1×1)=1`, unchanged).
- **Threads A + D (duplicate) — apple metric.** `hello_kitties` corrected
  `0.4 → 0.8` to match the `actual_apples / 5` convention (actual_apples = 4).
- **Threads B + C — scope wording.** `S = round(min(cssW/1280, cssH/720) × dpr)`
  also yields `S=2` for large `dpr=1` monitors whose FIT magnification alone
  reaches ~1.5+, not just HiDPI. Behaviour is intentional → reconciled the PR
  description, the ADR-0025 "Text resolution model" section, and the ADR
  Consequences (no-op now scoped to "on-screen magnification rounds to S=1";
  negative now covers large `dpr=1` monitors), no code change.

`verify:fast` green (typecheck + lint full; unit changed-set 35/35). Branch
force-pushed (`--force-with-lease`) after rebase. Threads replied `✅ Addressed`
and resolved via the `resolveReviewThread` GraphQL mutation as PR owner.
