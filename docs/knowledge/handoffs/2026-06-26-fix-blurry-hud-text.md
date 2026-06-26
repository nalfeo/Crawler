# 2026-06-26 Fix blurry HUD text

## Session summary

The HUD text (Floor 1 timer, circular minimap "MAP (M)" label + compass, QUESTS
tracker, and the health/mana/XP/skill/ability/boss/loot text) rendered blurry and
hard to read. Fixed by giving every persistent HUD `Text` object a device-aware
Phaser `resolution`, mirroring the pattern the modal UIs already use.

**Apple estimate:** 🍎🍎 (2) declared up front · **actual:** 🍎🍎 (2) · verdict 🎯 exact.

## Root cause

- `src/bootstrap/floor1-game-config.ts` sets `pixelArt: true` (→ `antialias: false`,
  NEAREST texture filtering) + `roundPixels: true` + `Scale.FIT` at a fixed
  1280×720 design resolution (`GAME.WIDTH/HEIGHT` in `src/shared/constants.ts`).
- `Scale.FIT` CSS-magnifies the 1280×720 canvas up to the display; on HiDPI / browser
  zoom the `devicePixelRatio` compounds it.
- Phaser `Text` rasterises glyphs to an internal texture at `fontSize × resolution`.
  At the default `resolution = 1`, FIT magnification (and DPR) upscales those glyph
  textures with nearest-neighbour → visibly blurry text.
- The modal UIs (`DialogueBox`, `LevelUpUI`, `ModalPickerUI`) already compensate with
  `setResolution(devicePixelRatio × uiScale)`. The persistent HUD text objects never
  called `setResolution`, so they stayed at resolution 1.

## Changes made

### `src/engine/ui-scale.ts` (new shared helpers)

- `MAX_TEXT_RESOLUTION = 4` cap (avoids absurd texture sizes on extreme DPR/zoom).
- Pure `computeTextResolution(displayWidth, displayHeight, devicePixelRatio, options)`:
  - `fitMagnification = min(displayW / designW, displayH / designH)` (limiting axis).
  - `onScreenScale = max(fitMagnification, responsiveScale) × dpr`.
  - returns `clamp(ceil(onScreenScale), 1, MAX_TEXT_RESOLUTION)`.
  - `ceil` oversamples (safe: oversample is crisp, undersample blurs). Degenerate
    display sizes (0 / NaN) and `dpr <= 0` fall back to `1`.
  - Raising `resolution` does **not** change `text.width` / `.height` (logical units),
    so there is **no layout shift**.
- `getTextResolution(scene)` reads the live display size + `devicePixelRatio` and feeds
  `getUiScale(scene)` in as `responsiveScale` (covers HUD corner groups that scale text
  up on small screens).
- `applyCrispText(scene, texts): () => void` applies the resolution to every text now
  **and** re-applies on `SCALE_RESIZE_EVENT` ('resize'); returns an unsubscribe fn.

### 10 HUD components wired (`src/engine/Hud*.ts`)

`HudFloorTimer`, `HudBossBar`, `HudLootCounter`, `HudQuestTracker`, `HudMinimap`,
`HudHealthBar`, `HudManaBar`, `HudExperienceBar`, `HudSkillTracker`, `HudAbilityBar`
each: import `applyCrispText`, call it on their text objects after construction storing
the returned detach fn, and call that detach fn first thing in `destroy()`.

### Tests

- `tests/unit/ui-scale.test.ts`: new `describe('computeTextResolution')` block, 8 cases
  (desktop native = 1, FIT magnification, DPR multiply, limiting axis, responsiveScale
  floor, clamp to MAX, non-positive dpr fallback, degenerate sizes). Suite green (16).

## Why the existing modal formula wasn't enough

`getUiScale` clamps to `1` when the display is ≥ the design size (i.e. desktop), so the
modal `dpr × uiScale` formula leaves resolution at 1 on a DPR=1 desktop monitor — yet
FIT is still magnifying the canvas there. `computeTextResolution` folds
`fitMagnification` in directly, so pure-magnification blur is fixed regardless of DPR.

## Validation

- `npm run verify:fast` → **PASS** (typecheck + lint + changed unit tests).
- `npm run verify` → every code gate **PASS**: typecheck, ESLint, Prettier, knip
  (dead-code), unit + coverage, integration, and `vite build`.
- **Known flake — not a regression:** the headless Floor 1 perf gate
  (`tests/headless/floor1-completion.test.ts:214`) failed on wall-clock budget
  (`< HEADLESS_WALL_TIME_BUDGET_MS = 30000`). Evidence it is environment CPU
  contention, not this change:
  1. **Frame counts are deterministic and identical run-to-run** (e.g. seed 3 · bow =
     15804, seed 7 · baseball-bat = 19506); only wall-clock varies wildly (seed 7 ·
     baseball-bat: 32.5s vs 98.4s across runs). The simulation result did not change.
  2. **Import-graph proof:** the headless test imports only `src/game/ai/*`,
     `src/core/*`, and `src/shared/*`; `headless-runner.ts` likewise pulls `bitecs`,
     `src/core`, `src/shared`, `src/game/ai`, `src/game`. **Nothing in the headless path
     imports `src/engine/`** — and every file I touched lives in `src/engine/`. The
     change is structurally incapable of affecting headless timing.
  3. The test self-documents as "a coarse blowup guard, not a precise SLA," and prior
     handoffs (`2026-06-25-headless-runner-pathfinding-slowdown.md`,
     `2026-06-25-restore-headless-seed15-gate.md`) record this gate as timing-sensitive
     on loaded hardware.
  - **Did not** raise the budget (masking) or skip the test. On CI's calibrated hardware
    the deterministic frame counts complete under budget.

## Next steps / open questions

- **Visual confirmation:** run `npm run dev` (or `npm run lab` → hud-lab) and eyeball the
  HUD; text should now be crisp at any zoom / on HiDPI. (Programmatic gates can't judge
  perceived sharpness.)
- **Out of scope (ask user):** world-space text — floating damage numbers, NPC name
  labels, interaction hints in `MainGameScene` — was left untouched. The report and
  screenshot were HUD-only. `applyCrispText` is reusable if we later want those crisp too.
