import type { GameWorld } from './world.js';

/**
 * Emits weapon skill usage events (class + type) for the given attack entity.
 *
 * Called by melee/projectile/beam/area-damage systems immediately after
 * `applyDamage` returns > 0 against an enemy. This ensures skills only
 * advance when an attack actually hits and deals damage.
 *
 * Uses per-attack attribution (`world.attackSkillSources` keyed by attack entity
 * EID) so projectiles fired by weapon A still credit weapon A's skills even if
 * the player switches to weapon B before the projectile lands.
 */
export function emitWeaponHitSkillEvents(world: GameWorld, attackEid: number): void {
  const source = world.attackSkillSources.get(attackEid);
  if (source === undefined) return;
  world.skillUsageEvents.push(
    {
      holderEid: source.attackerEid,
      skillId: source.classSkillId,
      metric: 'weapon_fired',
      amount: 1,
    },
    {
      holderEid: source.attackerEid,
      skillId: source.typeSkillId,
      metric: 'weapon_fired',
      amount: 1,
    },
  );
}

/**
 * Removes the skill source entry for the given attack entity.
 * Called when the attack entity expires or is explicitly destroyed to prevent
 * stale entries and incorrect attribution on recycled entity IDs.
 */
export function clearAttackSkillSource(world: GameWorld, attackEid: number): void {
  world.attackSkillSources.delete(attackEid);
}
