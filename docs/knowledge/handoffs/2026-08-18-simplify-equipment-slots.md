# Handoff: Simplify equipment slots

**Date:** 2026-08-18
**Persona:** Systems Engineer
**Apples:** 4 estimated, 4 actual

## Systems touched

equipment-slots, equipment-definitions, generated-equipment, player-carryover, reward-pools, sprite-pipeline

## Outcome

Reduced the active equipment contract to exactly `head`, `neck`, `mainHand`,
`chest`, `offHand`, `gloves`, `legs`, `ring1`, `feet`, and `ring2`.
Deprecated active slot IDs were removed from runtime definitions and authored
theme-equipment plans. Main-hand/off-hand behavior remains distinct.

Carryover validation now rejects retired equipped slots and filters retired
disabled-slot entries. Tests cover the exact registry, invalid slot handling,
theme plan validation, and the updated equipment fixtures.

## Verification

- `npm run verify:fast` passed.
- `npm run check:wired-systems` passed with no blocking findings.
- Targeted equipment and sprite tests passed.
- Deprecated-slot scan found only unrelated decoration-layer `back` values.
