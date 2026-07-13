# Loot/Skill HUD Polish

## Systems touched

hud-ux

## Summary

Polished the loot counter (`HudLootCounter`) and skill tracker (`HudSkillTracker`)
panels for the 1280x720 and 960x540 acceptance viewports:

- Added `hud-loot-format.ts`: compact number formatter (999 → 999, 1000 → 1K,
  1M → 1.0M) to prevent text overflow at high loot counts.
- `HudLootCounter`: responsive icon/text scaling within the beveled panel bounds.
- `HudSkillTracker`: pixel-measured text truncation via `setTextWithinWidth` with
  memoization cache to avoid per-frame canvas churn.
- Extended existing `src/labs/hud-lab/` with visual dev testing probes for loot + skill panels.
- New `tests/e2e/hud-overlap-visual.test.ts`: deterministic 1280×720 and 960×540
  containment assertions (no overlap, no viewport overflow).
- New `tests/unit/hud-loot-counter-format.test.ts`: boundary value tests for the
  compact formatter.

## Complexity

🍎🍎🍎 (3 apples) — 8 files changed total (7 cherry-picked + 1 review fix).

## Review

- Plan review: gpt-5.4, 5 concerns resolved, plan_divergence: minor.
- Code review: claude-sonnet-4.6, 1 concern (per-frame canvas churn in
  `setTextWithinWidth`), resolved with memoization cache.

## Preserved merged behavior

- Family fullscreen-map gating (#1118): `familyRelationships.setVisible(!hidden && !minimap.isOverlayOpen())`
- Abilities UX (#1095): `ABILITY_BAR_MAX_SCALE`
- Vitals scaling (#1116): `computeVitalsScale`

## Before/After

Before: loot counter could overflow panel at high values; skill names called
`setText` every frame causing unnecessary canvas redraws.

After: compact formatting prevents overflow; memoized truncation eliminates
per-frame churn. Deterministic containment tests pass at both viewports.
