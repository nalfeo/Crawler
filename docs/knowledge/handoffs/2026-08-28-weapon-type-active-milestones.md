# Handoff: Weapon-type active skill milestones

## Date

2026-08-28

## Persona

Game Designer

## Systems touched

weapons, vfx, ai-combat-balance

## Apples

Estimated: 🍎🍎🍎. Actual: pending final validation.

## Summary

- Converted all ten weapon-type combat skills' level-5 and level-15 rewards from
  passive placeholders into weapon-gated active abilities.
- Kept the old passive IDs registered for compatibility and assigned new
  `*-active` IDs to avoid persisted-kind mismatches.
- Added deterministic `active_damage` effects with physical/magic affinity,
  stable target ordering, real health damage, combat events, cooldowns, and
  existing ability-bar/announcement integration.
- Kept L10/L20 and non-Arcane weapon-class rewards passive.
- Updated skill unlock VFX mappings and AI loadout valuation.
- Fixed strict TypeScript narrowing in the release sweep capacity test that
  surfaced during required validation.

## Observe before done

- Before: the runtime catalog classified every weapon-type L5/L15 milestone as a
  passive; L5 entries commonly applied zero damage, and no active could fire.
- After: `tests/integration/weapon-type-active-unlocks.test.ts` drives each L5
  milestone through `createFloor1MainSceneOptions()` and the real engine
  `runSimulationStep` pipeline with its matching weapon, then observes an equipped
  active, a stamped cooldown, and an active-ability combat event.
- L15 replacement and every L5/L15 effect are covered across all ten skills in
  `tests/game/weapon-skill-abilities.test.ts`.

## Validation

- Targeted ability, registry, VFX, AI evaluator, and shipped-pipeline tests: passed.
- Remaining repository and review gates: pending.

## Follow-up

Use balance evidence to tune individual damage, range, target-count, and cooldown
values if the aggregate Floor 1 win rate or build diversity regresses.
