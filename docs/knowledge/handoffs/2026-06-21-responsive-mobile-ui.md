# Session Handoff: Responsive mobile UI scaling

## Date

2026-06-21

## Persona(s) adopted

Producer — the task spans multiple layers (shared scaling util in `src/engine`,
several menu overlays, and the full HUD), so it needed coordinated changes
across the rendering layer rather than a single-system specialist.

## Routing verdict

✅ right persona — multi-surface UI work benefited from a holistic plan
(shared foundation first, then menus, then HUD).

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — scope was well understood up front (one shared util + repeated
application across menus and HUD factories).

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

enemies, mobile-ux

## What Was Done

Made the game UI responsive to viewport size so text and interactive controls
are larger on small screens (the game renders at a fixed 1280×720 with
`Phaser.Scale.FIT`, so scene-space UI otherwise shrinks uniformly on mobile).

- Added `src/engine/ui-scale.ts` (pure `computeUiScale`, plus `getUiScale`,
  `fitUiScale`, `onUiScaleChange`). Kept node-testable by using `import type`
  for Phaser and the `'resize'` string literal (no runtime Phaser import).
  8 unit tests in `tests/unit/ui-scale.test.ts`.
- Interactive menus scale fully to fit the canvas via the "virtual viewport"
  technique (lay out at `sceneSize / uiScale`, then `overlay.setScale(uiScale)`,
  and bump text `setResolution` by the scale for crispness):
  `LevelUpUI`, `ModalPickerUI` (also fixes `GameOverUI` which delegates to it),
  `InventoryUI`, `DialogueBox`.
- HUD: threaded an optional `parent` container through `pixel-ui.ts` builders
  and every HUD factory, then `HudUI` groups elements into four corner
  containers (bottom-left, bottom-center, top-center, top-right) that each
  `setScale` + re-anchor on resize. HUD scale is capped at 1.4× to avoid
  corner-group collisions in the fixed-width layout. At scale 1 the layout is
  pixel-identical (regression-safe).

## What's Next

- Optional: true mobile HUD reflow/breakpoints for very narrow screens (the
  1.4× cap is a modest improvement; a ~390px-wide portrait phone still
  letterboxes the 16:9 canvas heavily). This is a larger effort, deliberately
  out of scope this pass.
- Minimap (`HudMinimap.ts`) is now responsive too: a follow-up pass scales the
  docked radar dial up on small screens (capped at 1.4×, anchored top-right),
  mirroring the HUD. It manages its own dynamic children/overlay, so the scaling
  lives in `HudMinimap.updateLayout` rather than a corner container.

## Blockers

None. The Playwright MCP browser profile was locked mid-session; used a
standalone `playwright` script for visual validation instead.

## Branch State

- Branch: `copilot/review-ux-for-mobile`
- All tests passing: yes
- PR created: no (not requested)

## Test Results

`npm run verify` passed (typecheck + lint + unit + integration + determinism +
Floor 1 completion gate + build). 1526 unit tests pass.

## Key Decisions Made

- Menus scale fully (capped only by `fitUiScale` so they never overflow the
  canvas); HUD uses a conservative cap because its corner groups are anchored
  independently and would collide at large scales.
- `ui-scale.ts` avoids runtime Phaser imports so the core math stays
  unit-testable in the node test environment.
- Visual validation confirmed desktop (1280×720) is pixel-identical and
  landscape-mobile (844×390) shows large, tappable controls.
