# ADR: Weapon-type level-5 and level-15 milestones grant active abilities

## Status

Accepted

## Date

2026-08-28

## Estimated Complexity

🍎🍎🍎

## Context

The weapon-type skills (`sword`, `dagger`, `hammer`, `bow`, `crossbow`, `pistol`,
`throwing-weapons`, `unarmed`, `spellcraft`, and `sports-equipment`) described
their level-5 and level-15 rewards as attacks, but their runtime definitions were
passive placeholders. Level 5 was often a zero-value stat modifier, while level
15 was an unconditional damage passive. The shared presentation table separately
described similarly named active abilities, so progression, runtime behavior, and
presentation disagreed.

PR #3795 established the runtime contract needed to fix this safely: milestone
grant/revoke operations derive the ability kind from the catalog, active grants
fill open bar slots, and weapon prerequisites suppress firing without consuming a
cooldown.

## Decision

1. Every weapon-type combat skill grants a weapon-gated `active` ability at
   levels 5 and 15. Level 15 replaces level 5. Weapon-class milestones remain
   passive except for Arcane's already-established active pair.
2. The new actives use new `*-active` IDs. Existing passive IDs remain registered
   as compatibility entries, avoiding a persisted ability changing kind in place.
3. Spellcraft follows the same pre-boss contract as Arcane: its milestone reward
   is `active`, not `spell`, so it is not blocked by the spellbook feature gate
   and does not train a spell-specific usage skill.
4. A shared `active_damage` catalog effect provides deterministic direct combat
   output. It selects living targets by squared distance and entity ID, applies
   physical or magic primary-stat scaling, emits normal combat-hit feedback, and
   records the damage as active-ability output.
5. Melee-style rewards hit a small nearby group; aimed and projectile-style
   rewards hit the nearest target. Level-15 versions deal more damage, reach
   farther, or hit more targets, and have shorter cooldowns.

## Consequences

- All ten weapon-type skills now deliver visible, executable L5/L15 rewards
  through the existing ability bar and simulation pipeline.
- A mismatched weapon leaves the active equipped but inert, preserving player
  bar configuration and cooldown state.
- The former level-15 global damage passives are intentionally replaced by
  cooldown-based attacks, so gameplay fingerprints and balance may change.
- The existing abilities and skill labs pick up the catalog entries without a
  new system or lab-only execution path.

## Alternatives Considered

- **Flip existing passive IDs to active.** Rejected because persisted grant
  ownership validates ability kind and could fail or lose grants after a kind
  change.
- **Reuse spell effects for every weapon.** Rejected because physical weapon
  rewards would incorrectly deal magic damage and inherit spell-specific visuals.
- **Convert weapon-class milestones too.** Rejected because those skills are
  explicitly the slower passive damage-progression track; Arcane remains the
  deliberate exception.

## Related

- `docs/knowledge/adr/2026-07-13-weapon-skill-level5-passive-abilities.md`
- `docs/knowledge/adr/2026-08-27-arcane-level5-active-ability.md`
- PR #3795
