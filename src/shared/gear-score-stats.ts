import type { EquipmentItemDef } from './equipment-types.js';
import type { StatusEffectSpec, StatusEffectStat } from './status-effect-types.js';
import type { StatId } from './stats.js';
import { getGearScoreTargetRange } from './gear-score-policy.js';

export const GEAR_STAT_WEIGHTS: Readonly<Partial<Record<StatId, number>>> = {
  strength: 4,
  dexterity: 3,
  constitution: 2,
  intelligence: 4,
  wisdom: 2,
  charisma: 0.5,
  luck: 1,
  armor: 2,
  damageBonus: 4,
  damagePercent: 40,
  attackSpeed: 40,
  moveSpeed: 30,
  critChance: 40,
  critMultiplier: 8,
  dodgeChance: 35,
  hpRegen: 6,
  xpBonus: 8,
  cooldownReduction: 40,
  maxHp: 0.1,
  accuracy: 18,
  pickupRange: 0.2,
  projectileSpeed: 2,
  projectileCount: 12,
};

const ACTIVE_ABILITY_GRANT_SCORE = 4;
const PASSIVE_ABILITY_GRANT_SCORE = 3;
export const _ACTIVE_ABILITY_GRANT_SCORE_FOR_TEST = ACTIVE_ABILITY_GRANT_SCORE;
export const _PASSIVE_ABILITY_GRANT_SCORE_FOR_TEST = PASSIVE_ABILITY_GRANT_SCORE;

export function scoreAbilityGrants(
  abilityGrants: readonly string[],
  passiveGrants: readonly string[],
): number {
  return (
    abilityGrants.length * ACTIVE_ABILITY_GRANT_SCORE +
    passiveGrants.length * PASSIVE_ABILITY_GRANT_SCORE
  );
}

export function scoreGearStats(stats: EquipmentItemDef['statBonuses']): number {
  return (Object.entries(stats) as [StatId, number][]).reduce(
    (sum, [stat, value]) => sum + value * (GEAR_STAT_WEIGHTS[stat] ?? 0),
    0,
  );
}

const STATUS_EFFECT_GEAR_STATS: Readonly<Record<StatusEffectStat, StatId>> = {
  speed: 'moveSpeed',
  hpRegen: 'hpRegen',
  attackSpeed: 'attackSpeed',
};

/**
 * Score permanent while-equipped modifiers in the same budget as ordinary
 * item stats. Rate channels use 1 as their neutral value; hpRegen uses 0.
 */
export function scoreEquipmentStatusEffects(
  effects: readonly StatusEffectSpec[] | undefined,
): number {
  if (!effects || effects.length === 0) return 0;

  let total = 0;
  for (const stat of ['speed', 'hpRegen', 'attackSpeed'] as const) {
    const matching = effects.filter((effect) => effect.stat === stat);
    if (matching.length === 0) continue;
    const base = stat === 'hpRegen' ? 0 : 1;
    const additive = matching
      .filter((effect) => effect.op === 'add')
      .reduce((sum, effect) => sum + effect.value, 0);
    const multiplier = matching
      .filter((effect) => effect.op === 'multiply')
      .reduce((product, effect) => product * effect.value, 1);
    const effectiveDelta = (base + additive) * multiplier - base;
    total += effectiveDelta * (GEAR_STAT_WEIGHTS[STATUS_EFFECT_GEAR_STATS[stat]] ?? 0);
  }
  return total;
}

/** Fill an authored non-weapon to its exact floor/rarity/slot midpoint. */
export function balanceNonWeaponDefinition(def: EquipmentItemDef, floor: number): EquipmentItemDef {
  if (def.weaponId) return def;
  const range = getGearScoreTargetRange(floor, def.rarity, def.slots);
  const target = (range.minimum + range.maximum) / 2;
  const current =
    scoreGearStats(def.statBonuses) + scoreEquipmentStatusEffects(def.grantsStatusEffects);
  const filler: StatId = def.slots.some((slot) =>
    ['head', 'chest', 'legs', 'feet', 'gloves', 'offHand'].includes(slot),
  )
    ? 'armor'
    : 'damageBonus';
  const weight = GEAR_STAT_WEIGHTS[filler]!;
  return {
    ...def,
    statBonuses: {
      ...def.statBonuses,
      [filler]: (def.statBonuses[filler] ?? 0) + (target - current) / weight,
    },
  };
}
