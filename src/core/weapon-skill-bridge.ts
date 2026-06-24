import type { GameWorld } from './world.js';

/**
 * Emits weapon skill usage events (class + type) for the given attacker.
 *
 * Called by melee/projectile/beam/area-damage systems immediately after
 * `applyDamage` returns > 0 against an enemy. This ensures skills only
 * advance when an attack actually hits and deals damage.
 */
export function emitWeaponHitSkillEvents(world: GameWorld, attackerEid: number): void {
  const skills = world.attackerWeaponSkills.get(attackerEid);
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
