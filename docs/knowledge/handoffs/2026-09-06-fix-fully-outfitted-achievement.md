# Fully Outfitted achievement and notification layout

## Systems touched

quests, hud-ux, inventory, labs

## Apples

Estimated 🍎🍎, actual 🍎🍎 — exact. The fix stayed within the planned shared
fact, achievement system, HUD layout, and focused test surfaces.

## Outcome

Issue #4288 is implemented. `Fully Outfitted` now uses a current-run fact that
is true only when every slot in `SLOT_REGISTRY` is occupied by equipped gear;
unlocking equipment or carrying bag items alone cannot satisfy it. Achievement
rows measure title and criteria text before placing subsequent text, and the
achievement toast moves below active director commentary.

## Evidence

- `npm run typecheck`
- `npm run lint -- --quiet`
- `npx vitest run tests/game/achievement-system.test.ts tests/property/achievement-facts-properties.test.ts tests/integration/achievements-ui-icon-render.test.ts`
- `npx vitest run tests/integration/achievements-ui-icon-render.test.ts tests/unit/main-game-scene-achievement-toast.test.ts`
- `npm run verify:fast` — fast verification passed.
- Repass fix: `flashAchievementToast` now repositions the visible toast against
  already-active director commentary before its timer starts, covering the
  ordering where the achievement arrives after commentary.
- Deterministic regression coverage: the achievement-system regression exercises
  empty, partial, and fully occupied equipment state plus a bag-only item; the
  real `AchievementsUI` integration path captures rendered text bounds for a
  multiline catalog entry at standard (1280x720) and compact (640x360)
  viewports; the toast layout helper asserts placement below multiline
  commentary and restoration after commentary hides.
- Repass regression coverage: `npm run test:e2e --
tests/e2e/main-game-scene-achievement-toast.test.ts` boots the real
  MainGameScene and confirms the toast is below active commentary, while the
  rendered Awards text regions remain separated for Fully Outfitted at both
  supported viewport sizes.
