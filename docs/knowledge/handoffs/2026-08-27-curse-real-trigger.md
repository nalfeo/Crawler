# Session Handoff: Curse real-game trigger

## Systems touched

weapons, vfx

## Apples

Estimated: 2🍎, actual: 2🍎.

## Summary

- Reproduced a real runtime trigger gap by adding a shipped-pipeline integration
  assertion where Curse did not fire with 3 nearby enemies.
- Lowered Curse's `enemy_cluster` trigger threshold from 4 to 3 enemies so it
  can trigger in practical in-game crowding.
- Added a regression check in
  `tests/integration/fireball-pulse-shield-integration.test.ts` that validates
  Curse enters cooldown and emits `curseBurst` while running the canonical
  visual simulation pipeline (`runSimulationStep` + floor scene options).
- Recovered the PR review finding by adding the other seven Floor 1 boss-reward
  spells to the same real-pipeline fixture. Every spell in
  `FLOOR1_BOSS_REWARD_SPELL_IDS` now proves its authored trigger reaches a
  cooldown stamp after the boss-reward selection path; Bless and Haste use
  starter-weapon events rather than `forceActivateAbility`.

## Files touched

- `src/game/abilities/registry.ts`
- `tests/integration/fireball-pulse-shield-integration.test.ts`
- `docs/knowledge/handoffs/2026-08-27-curse-real-trigger.md`

## Verification

- `npx vitest run tests/integration/fireball-pulse-shield-integration.test.ts`
  - Before trigger-tuning change: Curse test failed (`cooldownFrame` undefined).
  - After trigger tuning and all-spell review repair: 11/11 tests passed.
- `npx vitest run tests/game/ability-registry.test.ts tests/game/ability-system.test.ts`
  - 45/45 tests passed.
- `npm run verify:fast`
  - Passed.

## Unresolved issues

- None identified for this scope.

## Recommended next steps

- Observe the next playtest run bundle for non-zero `spell:curse`
  `activationCount` under normal progression.
