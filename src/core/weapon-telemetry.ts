/**
 * Optional per-run weapon telemetry — swings, connecting hits, accuracy, and
 * multi-hit rate for the PLAYER's attacks.
 *
 * **OFF by default.** The collector lives on the optional
 * {@link GameWorld.weaponTelemetry} field (undefined = disabled), so the shipping
 * simulation and the headless Floor-1 gate pay ZERO cost and observe NO behavior
 * change. It is switched on by opt-in surfaces (the headless runner's
 * `recordWeaponTelemetry` config and the PlayerSessionRecorder's
 * `recordWeaponTelemetry` option) when accuracy analysis is wanted.
 *
 * ## Model
 * One weapon activation (`dispatchAttack` fires) = one **swing** = one monotonic
 * **activation id**. Every attack entity spawned during that activation (melee
 * swing, projectile, or area-damage explosion) is TAGGED with the activation id at
 * its spawn choke point. An AoE-on-impact explosion inherits its parent
 * projectile's id (see {@link withInheritedActivation}) so a single fireball cast
 * stays ONE activation even though it spawns a projectile and then an explosion.
 *
 * Each enemy damaged by a tagged attack entity is unioned into that activation's
 * distinct-enemy set. Because activations are keyed by a stable monotonic id (not
 * a recyclable ECS entity id), aggregates are computed at read time with no
 * per-entity finalize step — a connecting activation is simply one whose set is
 * non-empty, and a multi-hit activation is one whose set has >= 2 members.
 *
 * ## Determinism
 * Pure counting: no Phaser, no bitecs world mutation, no `world.rng`, no
 * wall-clock. Every mutator is a no-op when telemetry is disabled, and the
 * `currentActivationId` is only set inside a player weapon dispatch, so attack
 * entities spawned by enemies (which never run during that synchronous window)
 * stay untagged and never pollute the player-weapon counts.
 */
import type { GameWorld } from './world.js';
import type { WeaponTelemetry, WeaponTelemetrySummary } from '../shared/weapon-telemetry-types.js';

export type { WeaponTelemetry, WeaponTelemetrySummary } from '../shared/weapon-telemetry-types.js';
export function createWeaponTelemetry(): WeaponTelemetry {
  return {
    swings: 0,
    accuracyMisses: 0,
    nextActivationId: 0,
    currentActivationId: undefined,
    entityActivation: new Map(),
    enemiesByActivation: new Map(),
  };
}

/**
 * Begin a weapon activation: count the swing and open a fresh activation id that
 * subsequently-spawned attack entities will be tagged with. No-op when disabled.
 */
export function beginWeaponActivation(world: GameWorld): void {
  const wt = world.weaponTelemetry;
  if (!wt) return;
  wt.swings += 1;
  wt.currentActivationId = wt.nextActivationId;
  wt.nextActivationId += 1;
}

/** End the current weapon activation so no further entities tag to it. No-op when disabled. */
export function endWeaponActivation(world: GameWorld): void {
  const wt = world.weaponTelemetry;
  if (!wt) return;
  wt.currentActivationId = undefined;
}

/** Mark the in-flight activation as an accuracy-roll whiff. No-op when disabled. */
export function markWeaponAccuracyMiss(world: GameWorld): void {
  const wt = world.weaponTelemetry;
  if (!wt) return;
  wt.accuracyMisses += 1;
}

/**
 * Tag a freshly-spawned attack entity with the in-flight activation id. No-op when
 * telemetry is disabled or when no activation is open (e.g. enemy-spawned attacks).
 */
export function tagAttackEntity(world: GameWorld, attackEid: number): void {
  const wt = world.weaponTelemetry;
  if (!wt || wt.currentActivationId === undefined) return;
  wt.entityActivation.set(attackEid, wt.currentActivationId);
}

/**
 * Read the activation id a tagged attack entity belongs to, or `undefined` when
 * telemetry is disabled or the entity is untagged. Callers snapshot this while the
 * entity still exists so a later nested spawn (e.g. an AoE-on-impact explosion,
 * spawned AFTER the parent projectile is destroyed and pruned) can be folded into
 * the same activation via {@link withActivationId}.
 */
export function getActivationForEntity(world: GameWorld, attackEid: number): number | undefined {
  const wt = world.weaponTelemetry;
  if (!wt) return undefined;
  return wt.entityActivation.get(attackEid);
}

/**
 * Run `fn` with the current activation temporarily set to `activationId`, so any
 * attack entity spawned inside `fn` is tagged to that activation. Used by
 * AoE-on-impact so an explosion is folded into its parent projectile's cast rather
 * than counted as a separate swing. An `undefined` id (parent was untagged, e.g. an
 * enemy projectile) leaves the child untagged. Always restores the previous
 * activation id, even on throw. No-op wrapper when telemetry is disabled.
 */
export function withActivationId(
  world: GameWorld,
  activationId: number | undefined,
  fn: () => void,
): void {
  const wt = world.weaponTelemetry;
  if (!wt) {
    fn();
    return;
  }
  const prev = wt.currentActivationId;
  wt.currentActivationId = activationId;
  try {
    fn();
  } finally {
    wt.currentActivationId = prev;
  }
}

/**
 * Record that a tagged player attack entity dealt damage to a distinct enemy.
 * Deduplicated per activation, so pierce / repeated arc contact / lingering AoE
 * count an enemy at most once per activation. No-op when disabled or untagged.
 */
export function recordWeaponEnemyHit(world: GameWorld, attackEid: number, enemyEid: number): void {
  const wt = world.weaponTelemetry;
  if (!wt) return;
  const activationId = wt.entityActivation.get(attackEid);
  if (activationId === undefined) return;
  let set = wt.enemiesByActivation.get(activationId);
  if (set === undefined) {
    set = new Set<number>();
    wt.enemiesByActivation.set(activationId, set);
  }
  set.add(enemyEid);
}

/**
 * Drop an attack entity's activation tag when the entity is cleaned up, bounding
 * `entityActivation`. The activation's recorded enemy set is retained (it is the
 * aggregate source). No-op when disabled.
 */
export function pruneAttackEntity(world: GameWorld, attackEid: number): void {
  const wt = world.weaponTelemetry;
  if (!wt) return;
  wt.entityActivation.delete(attackEid);
}

/** Compute the read-only rollup from a live collector. */
export function summarizeWeaponTelemetry(wt: WeaponTelemetry): WeaponTelemetrySummary {
  let connectingSwings = 0;
  let multiHitSwings = 0;
  let totalEnemyHits = 0;
  for (const set of wt.enemiesByActivation.values()) {
    const n = set.size;
    if (n >= 1) {
      connectingSwings += 1;
      totalEnemyHits += n;
    }
    if (n >= 2) {
      multiHitSwings += 1;
    }
  }
  return {
    swings: wt.swings,
    accuracyMisses: wt.accuracyMisses,
    connectingSwings,
    multiHitSwings,
    totalEnemyHits,
    accuracy: wt.swings > 0 ? connectingSwings / wt.swings : 0,
    multiHitRate: connectingSwings > 0 ? multiHitSwings / connectingSwings : 0,
    avgEnemiesPerConnectingSwing: connectingSwings > 0 ? totalEnemyHits / connectingSwings : 0,
  };
}
