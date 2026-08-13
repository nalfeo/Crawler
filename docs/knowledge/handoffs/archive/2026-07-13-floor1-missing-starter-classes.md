# Add flagged Floor 1 starter options for missing weapon classes

**Date:** 2026-07-13  
**Persona:** Game Designer  
**Apples:** Estimated 🍎🍎 · Actual 🍎🍎 · 🎯 exact

## Systems touched

weapons, inventory, hud-ux, sprite-workflow

## Summary

- Added an opt-in Floor 1 starter flag via `?floor1ExperimentalStarters=1`.
- Kept the shipped default starter pool unchanged, but when the flag is enabled the real Floor 1 scenario appends `laser` (beam), `punch` (fist/unarmed), and `landmine` (trap).
- Extended the legacy loadout scenario helper to expose the same three experimental options when the flag is enabled.
- Added canonical item/equipment identities for `laser`, `punch`, and `landmine` so flagged starters equip through the existing starter/equipment path.
- Added matching weapon art-plan backlog entries so the item catalog stays fully covered by sprite planning guards.

## Runtime observation

- Before: the real Floor 1 scenario initializer produced a starter pool of only the canonical six (`sword`, `bow`, `baseball-bat`, `pistol`, `throwing-knife`, `fireball`); with seed 42 its sampled choices were `sword`, `baseball-bat`, `throwing-knife`.
- After: with `?floor1ExperimentalStarters=1`, the real Floor 1 scenario initializer widens the starter pool to nine by appending `laser`, `punch`, and `landmine`; with seed 42 its sampled choices included the new beam option (`bow`, `baseball-bat`, `laser`).

## Files touched

- `src/shared/floor1-starter-weapons.ts`
- `src/game/floorScenario.ts`
- `src/game/scenarios/floorLoadoutScenario.ts`
- `src/shared/equipmentDefs.ts`
- `src/shared/items.ts`
- `plans/item-icons/weapons.art.yaml`
- `tests/game/floor1-loadout-scenario.test.ts`
- `tests/game/floor1-scenario.test.ts`
- `tests/unit/floor1-config.test.ts`
- `tests/unit/items.test.ts`

## Verification

- `npx vitest run tests/game/floor1-loadout-scenario.test.ts tests/game/floor1-scenario.test.ts tests/unit/floor1-config.test.ts tests/unit/items.test.ts`
- `npx vitest run tests/unit/sprites/art-plan-catalog.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-13-floor1-missing-starter-classes.review-ledger.json`

## Unresolved issues

- The new starters are intentionally hidden by default and are only reachable through the opt-in query-param flag until balance is approved.
- No broad balance sweep was run locally because the issue explicitly requested a feature-flagged rollout first; follow-up balance work should use the normal GitHub sweep path if the flag graduates.

## Recommended next steps

- If these starters feel good under playtest/sweeps, promote them from the opt-in flag into the default Floor 1 starter pool.
- If the flag graduates, update any sweep/workflow allowlists that still assume the canonical six-weapon Floor 1 set.
