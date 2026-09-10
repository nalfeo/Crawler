# Handoff: Restore Floor 3 pet combat

## Date

2026-09-01

## Systems touched

enemies, ai-behavior-tree

## What changed

- Made the Floor 3 Wrangler invincible and removed fresh-start weapon setup.
- Added Floor 3-only weapon suppression so carried-over weapons cannot fire.
- Added deterministic companion auto-attacks and redirects wild trash targets from the Wrangler to the nearest living party Companion.
- Kept the systems in the shared Floor 3 scenario pipeline before enemy AI.

## Verification

- `npx vitest run tests/game/floor3-companion-combat.test.ts tests/unit/floor3-overworld.test.ts tests/game/floor1-main-scene-options.test.ts --project unit`
- `npx vitest run tests/headless/floor3-poach-loadout.test.ts --project headless`
- `npm run typecheck`
- `npm run lint -- --quiet`
- `npm run verify:fast`
- Real headless artifact: Floor 3 seed 4015 for 1,800 frames recorded 662 pet damage and zero player damage taken.
