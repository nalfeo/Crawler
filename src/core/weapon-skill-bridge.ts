import type { GameWorld } from './world.js';

/**
 * Emits weapon skill usage events using per-attack attribution when available,
 * falling back to the attacker-level map for legacy callers.
 *
 * A per-entity mapping of `null` (as opposed to "absent") explicitly opts an
 * attack entity OUT of the attacker-level fallback — used for non-weapon
 * attack entities (e.g. a spell-cast projectile) so a hit is never
 * mis-attributed to whatever weapon the player last fired.
 */
export function emitWeaponHitSkillEventsForSource(
  world: GameWorld,
  attackerEid: number,
  attackSourceEid: number,
): void {
  const entityScoped = world.attackWeaponSkillsByEntity.get(attackSourceEid);
  if (entityScoped === null) return;
  const skills = entityScoped ?? world.attackerWeaponSkills.get(attackerEid);
  if (skills === undefined) return;
  world.skillUsageEvents.push(
    {
      holderEid: attackerEid,
      skillId: skills.classSkillId,
      metric: 'weapon_fired',
      amount: 1,
    },
    {
      holderEid: attackerEid,
      skillId: skills.typeSkillId,
      metric: 'weapon_fired',
      amount: 1,
    },
  );
}
