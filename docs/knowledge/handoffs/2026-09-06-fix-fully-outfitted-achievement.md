# Fully Outfitted achievement and notification layout

## Systems touched

quests, hud-ux, inventory

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
- `npm run verify:fast` — 294 files and 3714 tests passed; fast verification passed.
- Deterministic before/after coverage: the achievement-system regression exercises
  empty, partial, and fully occupied equipment state plus a bag-only item; the
  real `AchievementsUI` integration path remains covered by the generated-icon
  render tests, and the real scene toast path now positions from measured
  commentary height.
