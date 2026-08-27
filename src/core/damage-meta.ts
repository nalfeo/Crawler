/**
 * Damage-scaling metadata — persisted, fail-closed tagging for delayed
 * damage-bearing entities (projectiles, area-damage/explosions, beams, melee
 * swings, traps). Tagged once at spawn time (or propagated onto a later
 * explosion/impact entity spawned from a tagged one — see `propagateDamageMeta`)
 * so the collision system that eventually calls `applyDamage` doesn't need to
 * re-resolve which weapon/spell created it.
 *
 * Fail-closed: an untagged (or freshly-recycled) entity decodes to
 * `{ origin: 'environment', affinity: 'unscaled', scaleWithPrimary: false,
 * canCrit: false, fromActiveAbility: false }` — numeric zero in every field —
 * so it can never accidentally scale or crit. `clearEntityStores` (see
 * `spawners/entity-core.ts`) already zeroes every typed array (including this
 * one) on entity creation and removal, so recycled EIDs can never leak a
 * previous entity's metadata.
 */

import { addComponent, hasComponent } from 'bitecs';
import { DamageMeta } from './components.js';
import type { GameWorld } from './world.js';
import type { DamageAffinity } from '../shared/stats.js';

/** Who dealt this damage. Fail-closed default: `'environment'` (never scales/crits). */
export type DamageOrigin = 'player' | 'enemy' | 'environment';

/** The subset of {@link DamageOptions} that persists onto a delayed entity. */
export interface PersistedDamageMeta {
  readonly origin: DamageOrigin;
  readonly affinity: DamageAffinity;
  readonly scaleWithPrimary: boolean;
  readonly canCrit: boolean;
  /**
   * Mirrors `DamageOptions.fromActiveAbility` (see `apply-damage.ts`) through
   * to the eventual delayed hit, so ability-vs-weapon damage attribution
   * (e.g. `equipment-balance-harness.ts`) stays correct for projectile/AoE
   * damage that resolves after cast time (Magic Missile — issue #3248).
   * Optional/defaults to `false` so existing untagged callers are unaffected.
   */
  readonly fromActiveAbility?: boolean;
}

/** Damage metadata after decoding from stores; all optional input fields are normalized. */
export interface DecodedDamageMeta extends PersistedDamageMeta {
  readonly fromActiveAbility: boolean;
}

/** Fail-closed defaults — never scales, never crits, environment-sourced. */
export const FAIL_CLOSED_DAMAGE_META: DecodedDamageMeta = {
  origin: 'environment',
  affinity: 'unscaled',
  scaleWithPrimary: false,
  canCrit: false,
  fromActiveAbility: false,
};

const ORIGIN_CODE: Readonly<Record<DamageOrigin, number>> = {
  environment: 0,
  player: 1,
  enemy: 2,
};
const ORIGIN_FROM_CODE: readonly DamageOrigin[] = ['environment', 'player', 'enemy'];

const AFFINITY_CODE: Readonly<Record<DamageAffinity, number>> = {
  unscaled: 0,
  physical: 1,
  magic: 2,
};
const AFFINITY_FROM_CODE: readonly DamageAffinity[] = ['unscaled', 'physical', 'magic'];

/** Persist damage-scaling metadata onto a delayed damage-bearing entity. */
export function tagDamageMeta(world: GameWorld, eid: number, meta: PersistedDamageMeta): void {
  if (!hasComponent(world.ecs, eid, DamageMeta)) {
    addComponent(world.ecs, eid, DamageMeta);
  }
  world.stores.damageMeta.origin[eid] = ORIGIN_CODE[meta.origin];
  world.stores.damageMeta.affinity[eid] = AFFINITY_CODE[meta.affinity];
  world.stores.damageMeta.scaleWithPrimary[eid] = meta.scaleWithPrimary ? 1 : 0;
  world.stores.damageMeta.canCrit[eid] = meta.canCrit ? 1 : 0;
  world.stores.damageMeta.fromActiveAbility[eid] = meta.fromActiveAbility ? 1 : 0;
}

/**
 * Read back persisted damage metadata for an entity. Fresh/untagged entities
 * fail closed (never scale/crit) since every field decodes safely from a zero
 * typed-array slot.
 */
export function readDamageMeta(world: GameWorld, eid: number): DecodedDamageMeta {
  const { damageMeta } = world.stores;
  return {
    origin: ORIGIN_FROM_CODE[damageMeta.origin[eid] ?? 0] ?? 'environment',
    affinity: AFFINITY_FROM_CODE[damageMeta.affinity[eid] ?? 0] ?? 'unscaled',
    scaleWithPrimary: (damageMeta.scaleWithPrimary[eid] ?? 0) !== 0,
    canCrit: (damageMeta.canCrit[eid] ?? 0) !== 0,
    fromActiveAbility: (damageMeta.fromActiveAbility[eid] ?? 0) !== 0,
  };
}

/** Copy one entity's persisted damage metadata onto another (e.g. a splash-damage explosion spawned from a tagged projectile/trap). */
export function propagateDamageMeta(world: GameWorld, fromEid: number, toEid: number): void {
  tagDamageMeta(world, toEid, readDamageMeta(world, fromEid));
}
