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
