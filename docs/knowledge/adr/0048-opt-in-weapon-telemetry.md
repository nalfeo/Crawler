# ADR 0048: Opt-in per-run weapon telemetry (accuracy + multi-hit)

## Status

Accepted

> Grandfathered tactical instrumentation ADR. If run telemetry grows beyond the
> current accumulator and recorder surfaces, promote it into a dedicated spec;
> until then, treat the code and tests as the current contract and this ADR as
> rationale.

## Date

2026-07-06

## Estimated Complexity

🍎 x 3 — spans `src/core` (ECS spawners + damage/melee/area systems), `src/game`
(weapon dispatch + headless runner + session recorder), and `src/shared`
(types), but adds no new `*System` and no new lab.

## Context

We want to measure how a player's weapon performs across a run — how many
attacks connect (accuracy) and how many hit multiple enemies at once (multi-hit
rate) — to inform weapon balance and the AI weapon sweep. The hard constraint is
that gathering this data must NOT perturb the shipping simulation or the
deterministic Floor-1 headless gate: the sim is seed-deterministic and any extra
allocation, branch, or RNG draw in the hot path risks shifting golden outputs.

A weapon "cast" is not one entity: a melee swing is one entity, a fireball is a
projectile that later spawns a separate explosion entity, a boomerang is a
returning projectile, and enemy attacks flow through the same spawners. Naively
counting attack entities would over-count casts and misattribute enemy attacks
to the player.

## Decision

Add a **data-only, off-by-default** telemetry accumulator:

- `src/shared/weapon-telemetry-types.ts` holds the pure `WeaponTelemetry` and
  `WeaponTelemetrySummary` interfaces. They live in `shared` (not `core`)
  because `src/shared` must not import `src/core`, yet `SessionRecorderStats`
  (in shared) needs the summary type. `src/core/weapon-telemetry.ts` imports and
  re-exports them.
- `src/core/weapon-telemetry.ts` is a pure accumulator (no `*System`, no
  `world.rng`, no `Date.now`, no Phaser). It hangs off an OPTIONAL
  `world.weaponTelemetry` field. **`undefined` = disabled = every mutator is a
  no-op with zero allocation.** `DEFAULT_CONFIG.recordWeaponTelemetry = false`.
- **One cast = one monotonic activation id.** `beginWeaponActivation` (called in
  `weaponSystem.dispatchAttack` for every weapon type) increments `swings` and
  opens a fresh activation id. Attack entities spawned during that activation are
  tagged at their spawn choke points (`src/core/spawners/melee.ts`,
  `src/core/spawners/projectiles.ts`). Tagging is a no-op when no activation is open, so
  enemy-spawned attacks (which never run inside a player dispatch) stay untagged.
- **Enemy hits union into a per-activation set**, so pierce / repeated arc
  contact counts an enemy at most once per activation. `connectingSwings` =
  activations with ≥1 distinct enemy; `multiHitSwings` = activations with ≥2.
- **AoE-on-impact inheritance.** A fireball's explosion spawns AFTER the
  projectile is destroyed and pruned. `aoeOnImpactPreDamage` snapshots the
  projectile's activation id via `getActivationForEntity`; `postDamage` re-applies
  it via `withActivationId` so one fireball stays one activation.
- **Prune activation tags on every despawn path.** `damageSystem.destroyEntity`,
  `projectileCleanupSystem` (all 4 despawn sites), and
  `returningProjectileSystem` (both despawn sites) call `pruneAttackEntity`
  before `removeEntity` to bound `entityActivation` and avoid recycled-eid
  misattribution. Melee/area attacks prune in their `clear*Hits`.
- Opt-in surfaces: the headless runner's `recordWeaponTelemetry` config flag
  (+ `--weapon-telemetry` CLI flag) and `PlayerSessionRecorder`'s
  `recordWeaponTelemetry` option. The recorder gates both collector install and
  `getStats()` exposure on its own opt-in flag so it never reports a collector
  installed elsewhere on the shared world.

## Consequences

### Positive

- Accuracy + multi-hit data available for weapon balance and the AI sweep with a
  single opt-in flag.
- Zero-delta when disabled: proven byte-identical via the collision-pair-parity
  goldens and the full VERIFY_FULL Floor-1 headless gate.
- Robust cast model handles melee, projectiles, AoE inheritance, pierce dedup,
  and enemy-attack exclusion without a per-entity finalize step (aggregates are
  computed at read time from stable activation ids).

### Negative

- Every player-attack despawn path now has an extra `pruneAttackEntity` call.
  It is a no-op when disabled, but it is one more invariant future spawn/despawn
  code must uphold.

### Risks

- **Beam/trap under-reporting (documented known limitation).** Beam (laser) and
  trap (landmine) casts increment `swings` via `dispatchAttack`, but their damage
  entities are not tagged, so beam/trap-heavy runs under-report accuracy. The
  Floor-1 weapon sweep — the primary consumer — uses only melee/ranged starting
  weapons, so it is unaffected. Extending tagging to beam/trap is a follow-up.
- A future despawn path for a taggable attack entity that forgets to prune would
  leak `entityActivation` entries (bounded, no correctness impact while disabled).

## Alternatives Considered

- **Count attack entities directly** — rejected: over-counts casts (fireball =
  projectile + explosion), can't dedup pierce, and would need extra state to
  exclude enemy attacks.
- **Put the interfaces in `src/core`** — rejected: `src/shared` cannot import
  `src/core`, and `SessionRecorderStats` (shared) needs the summary type.
- **Always-on telemetry** — rejected: any hot-path allocation/branch risks
  shifting the deterministic Floor-1 goldens; off-by-default keeps the shipping
  sim byte-identical.
- **Finalize aggregates per entity on despawn** — rejected: read-time
  aggregation from activation-keyed sets is simpler and survives entity pruning.
