# ADR: Carry hostile source identity across delayed AoE damage

## Status

Accepted

## Date

2026-07-17

## Estimated Complexity

🍎 x 2 — narrow attribution follow-up spanning the delayed-damage core
pipeline, regression coverage, and the headless telemetry contract that
consumes `CombatEvent.sourceArchetypeKey`.

## Context

PR #1231 added stable hostile-damage attribution so headless `RunStats` could
report which enemy archetypes actually damaged the player during focused Floor 2
hunts. Direct hostile-projectile hits were fixed by snapshotting the shooter's
archetype key onto the projectile at spawn time and forwarding that snapshot to
`applyDamage`.

Hostile fireballs are a two-stage delayed-damage path:

1. `spawnAoeProjectile` creates the in-flight projectile.
2. `damageSystem` destroys that projectile on impact.
3. `aoeOnImpactPostDamage` spawns a new `AreaDamage` explosion entity.
4. `areaDamageSystem` eventually applies the splash hit.

If the original shooter dies before impact and its EID is recycled, step 4
cannot safely fall back to `Owner.eid` at splash-hit time. The direct-hit path
would be correct while the delayed splash path would become `unknown` or point
at the wrong archetype.

This contract spans more than one system/workflow:

- Core combat/damage systems must preserve stable source identity through
  delayed entity lifecycles.
- Headless telemetry depends on the emitted `CombatEvent.sourceArchetypeKey`
  staying correct for both direct hits and delayed splash hits.

## Decision

Treat the hostile archetype snapshot as delayed-attack metadata that survives
the projectile → explosion handoff:

1. `aoeOnImpactPreDamage` snapshots the projectile's stable
   `enemyProjectileArchetypeKeys` entry before `damageSystem` destroys the
   projectile and clears its metadata.
2. `aoeOnImpactPostDamage` copies that snapshotted key onto the spawned
   explosion `AreaDamage` entity.
3. `areaDamageSystem` forwards the explosion entity's stored key to
   `applyDamage` as `sourceArchetypeKey`, rather than re-resolving the live
   owner EID.
4. `world.enemyProjectileArchetypeKeys` is documented as explicit
   lifecycle-managed metadata for hostile delayed-damage entities, not a
   projectile-only cache with implicit overwrite semantics.

## Consequences

### Positive

- Direct hostile hits and delayed hostile splash hits now agree on source
  identity even when the shooter dies before impact.
- Headless damage-source summaries can trust `sourceArchetypeKey` for both
  hostile projectile phases.
- Deterministic regression coverage can target recycled-EID direct-hit and AoE
  splash cases separately without relying on headless smoke tests.

### Negative / Risks

- Future hostile delayed-damage spawners must either set or intentionally leave
  unset this metadata, rather than assuming projectile-only usage.

## Alternatives Considered

- **Resolve the owner EID live at splash-hit time.** Rejected because it repeats
  the stale/recycled-EID failure mode the snapshot path was added to prevent.
- **Introduce a second map only for spawned explosions.** Rejected as needless
  duplication for this narrow fix; the existing lifecycle-managed map already
  clears safely on entity removal/reuse and can carry the metadata across the
  projectile/explosion handoff.

## Systems Touched

`enemies`, `weapons`, `ai-combat-balance`
