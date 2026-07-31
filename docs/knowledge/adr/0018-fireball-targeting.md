# ADR 0018: Fireball Spell Targeting (Any Enemy, Cluster-Preferring)

## Status

Accepted

**Date:** 2026-06-25
**Deciders:** Producer (game systems)

## Estimated Complexity

🍎🍎 — touches 2 layers (`src/game` logic + a `src/engine` UI string), but no new
ECS system, lab, or schema migration.

## Context

The player Fireball spell auto-cast via an `enemy_cluster` trigger that required
`minEnemies: 2` within 6 ft, then detonated centered on the caster
(`castFireball` damaged everything within the AoE radius of the player). Against a
single enemy or spread-out enemies the spell sat idle, which felt unresponsive.

Design request: Fireball should fire at _any_ enemy without waiting for a group,
while still _prioritizing_ groups in range when they exist — but not be exclusive
to groups.

This is a cross-layer change: the targeting logic lives in `src/game/systems`
(plus the ability registry/schema in `src/game/abilities`), and the player-facing
trigger/description copy lives in `src/engine/scenes/MainGameScene.ts`.

## Decision

1. **Relax the trigger** from `minEnemies: 2` to `minEnemies: 1` (and loosen the
   `enemy_cluster` Zod schema `minEnemies` from `.min(2)` to `.min(1)`). The 6 ft
   trigger range is unchanged, so _when_ the spell fires is otherwise the same.
2. **Make the blast targeted** instead of self-centered. `castFireball` now:
   - Considers every living enemy within blast reach (`radiusPx`) of the caster as
     a candidate epicenter.
   - Picks the candidate whose explosion catches the most enemies (group priority).
   - Breaks ties by proximity to the caster (lone-enemy fallback, so a single
     enemy is still hit).
   - Detonates at that point; knockback source is the chosen epicenter.
3. **Update UI copy** to "hits the nearest enemy, favoring clusters".

### Key Semantics

- Targeting search radius reuses the existing AoE `radiusPx` (no new effect
  fields). The spell triggers when an enemy is within 6 ft, but once triggered it
  can retarget onto a denser group up to one blast-radius away.
- The enemy-AI weapon-def `fireball` (mob projectile) is a separate entity and is
  unchanged.

## Consequences

### Positive

- Fireball is responsive against single targets while still rewarding grouped
  enemies — matches the design intent ("prioritize groups, not exclusive").
- Self-contained: no schema migration, no new component, no new effect parameters.
- Deterministic (no RNG); fully covered by unit tests.

### Negative

- Targeting is O(n^2) over living enemies per cast. Acceptable: casts are gated by
  a 5 s cooldown and MP, and enemy counts on screen are small.
- The triggering enemy is not guaranteed to be hit; if a denser cluster sits within
  blast reach, the blast lands there and a lone nearby enemy can be spared until the
  next cast.

### Risks

- Trigger range (6 ft) is narrower than the targeting reach (one blast-radius). An
  enemy in the 6-12 ft band will not _start_ a cast on its own, only be caught once
  a closer enemy trips the trigger. Left intentionally to avoid changing balance
  around when the spell fires; widening `withinFeet` to match the blast radius is a
  one-line follow-up if desired.

## Alternatives Considered

1. **Keep it self-centered, only drop the 2-enemy gate.** Rejected: satisfies "fire
   at any enemy" but not "prioritize groups in range," since the blast would never
   reach a cluster standing off to the side.
2. **Add an explicit `rangeTiles` field to the `spell_fireball` effect.** Rejected
   as unnecessary surface area; reusing `radiusPx` keeps the effect self-contained.
3. **Widen the trigger range to match the blast reach.** Deferred: it changes when
   the spell fires (a balance shift the request did not ask for). Noted as an easy
   follow-up.

## References

- Ability registry: `src/game/abilities/registry.ts`
- Trigger schema: `src/game/abilities/types.ts`
- Targeting logic: `src/game/systems/progressionEffects.ts` (`castFireball`)
- UI copy: `src/engine/scenes/MainGameScene.ts`
- Tests: `tests/game/ability-system.test.ts`
- Handoff: `docs/knowledge/handoffs/archive/2026-06-25-fireball-target-any-enemy.md`
