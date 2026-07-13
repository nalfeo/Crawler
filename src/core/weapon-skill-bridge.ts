import type { GameWorld } from './world.js';

/**
 * Emits weapon skill usage events using per-attack attribution when available,
 * falling back to the attacker-level map for legacy callers.
 */
export function emitWeaponHitSkillEventsForSource(
  world: GameWorld,
  attackerEid: number,
  attackSourceEid: number,
): void {
  const skills =
    world.attackWeaponSkillsByEntity.get(attackSourceEid) ??
    world.attackerWeaponSkills.get(attackerEid);
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
