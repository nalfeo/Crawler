import { ABILITY_MILESTONE_LEVELS, learnedAbilityIds, type PetSpeciesDef } from './species.js';

/**
 * Shared automatic attack techniques. Species keep their authored ability IDs
 * and style's melee/projectile delivery; these are not bespoke spell effects.
 * Damage multiplies the evolved style damage. Cooldown multiplies the recovery
 * AFTER this attack, so learning an ability cannot shorten an in-flight recovery.
 */
export const COMPANION_ATTACK_PROFILES = Object.freeze([
  Object.freeze({ damageMultiplier: 1, cooldownMultiplier: 1 }),
  Object.freeze({ damageMultiplier: 1.1, cooldownMultiplier: 0.9 }),
  Object.freeze({ damageMultiplier: 1.35, cooldownMultiplier: 1.1 }),
  Object.freeze({ damageMultiplier: 1.6, cooldownMultiplier: 1.2 }),
  Object.freeze({ damageMultiplier: 1.8, cooldownMultiplier: 1.25 }),
]);

export interface CompanionAutomaticAttack {
  readonly abilityId: string;
  readonly milestoneLevel: number;
  readonly damageMultiplier: number;
  readonly cooldownMultiplier: number;
}

/** All learned attacks are automatically enabled, in authored milestone order. */
export function learnedCompanionAttacks(
  species: PetSpeciesDef,
  level: number,
): readonly CompanionAutomaticAttack[] {
  return learnedAbilityIds(species, level).map((abilityId, index) => ({
    abilityId,
    milestoneLevel: ABILITY_MILESTONE_LEVELS[index]!,
    ...COMPANION_ATTACK_PROFILES[index]!,
  }));
}
