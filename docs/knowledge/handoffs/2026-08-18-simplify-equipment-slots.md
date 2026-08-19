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

Removed retired-category equipment rather than remapping it into surviving
slots: visors, pauldrons, cloaks, belts, armguards, vambraces, bracers, and
bracelets no longer appear in static definitions, generated equipment sources,
reward pools, or theme equipment plans. Naturally valid tunics, hauberks, and
gloves remain in their matching active slots. No save migration was added
because this deprecation has no save-state compatibility requirement.

Carryover validation now rejects retired equipped slots and filters retired
disabled-slot entries. Tests cover the exact registry, invalid slot handling,
theme plan validation, and the updated equipment fixtures.

Follow-up review added deterministic retirement migration for older snapshots:
static retired items are dropped from inventory/equipment, and generated
instances with retired frozen slots are removed from the registry and player
ownership before restore. Surviving generated instance IDs remain stable, so
the registry permits sparse historical ordinals only on carryover restore.
Theme roster prompts and persisted-plan parsing now reject retired slot
literals. ADR 0083 records the cross-system contract.

## Verification

- `npm run verify:fast` passed.
- `npm run check:wired-systems` passed with no blocking findings.
- Targeted equipment and sprite tests passed.
- A source scan found no retired equipment IDs or deprecated active slot IDs in
  static definitions, generated equipment sources, or authored theme plans.
