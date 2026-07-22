# ADR: Active-ability DPS event attribution for the equipment balance harness

## Status

Accepted

## Date

2026-07-21

## Estimated Complexity

🍎🍎 — spans `src/core/`, `src/game/`, `src/shared/`, and `src/bootstrap/` to keep one deterministic attribution seam across combat and the balance harness.

## Context

The equipment balance harness reports both aggregate DPS and the contribution
from active abilities. The first implementation derived `activeAbilityDps` by
subtracting a weapon-only replay from a full replay with the same seed.

That subtraction was not reliable because player active abilities can consume
the same combat RNG used by weapon accuracy and crit resolution. Once the full
run cast an active ability, later weapon outcomes diverged from the comparison
run, so the subtraction could include unrelated RNG drift instead of only
ability damage.

## Decision

1. The combat pipeline tags player active-ability hits at the shared
   `applyDamage` seam via `DamageOptions.fromActiveAbility` and the corresponding
   `CombatEvent.fromActiveAbility` field.
2. The equipment balance harness runs a single full encounter and sums tagged
   combat-event damage to measure `activeAbilityDps`.
3. The harness derives `weaponAndPassiveDps` from the same encounter
   (`aggregateDps - activeAbilityDps`) instead of running a second comparison
   simulation.

## Consequences

### Positive

- Active-ability attribution now comes from the same RNG sequence that produced
  the reported aggregate DPS.
- The harness no longer depends on paired-run subtraction across divergent crit
  or accuracy rolls.
- Combat-event consumers have an explicit, reusable source tag for future
  diagnostics.

### Negative

- Combat events now carry one more field that downstream consumers must preserve
  if they clone or serialize the event shape.
- Ability attribution depends on routing every relevant active-ability damage
  path through the shared tagged damage seam.

### Risks

- A future active ability that bypasses the tagged `applyDamage` path would be
  omitted from the attribution total until the seam is updated.

## Alternatives Considered

1. **Keep paired runs with the same seed** — rejected because active-ability
   casts still perturb later weapon RNG, so the subtraction is not ability-only.
2. **Measure a separate active-only encounter** — rejected because it would no
   longer reflect the exact aggregate run the gate reports.
3. **Add ability-specific logging only inside the harness** — rejected because
   the real source of truth is the shared combat-damage seam, not harness-local
   bookkeeping.
