/**
 * Stat definitions — primary and secondary stats with clamp ranges.
 */

export const PRIMARY_STATS = [
  'strength',
  'dexterity',
  'constitution',
  'intelligence',
  'wisdom',
  'charisma',
  'luck',
] as const;

export const SECONDARY_STATS = [
  'armor',
  'damageBonus',
  'attackSpeed',
  'moveSpeed',
  'critChance',
  'critMultiplier',
  'dodgeChance',
  'hpRegen',
  'xpBonus',
  'cooldownReduction',
] as const;

export type PrimaryStatId = (typeof PRIMARY_STATS)[number];
export type SecondaryStatId = (typeof SECONDARY_STATS)[number];
export type StatId = PrimaryStatId | SecondaryStatId;

export const ALL_STAT_IDS: readonly StatId[] = [...PRIMARY_STATS, ...SECONDARY_STATS];
export const VALID_STAT_IDS: ReadonlySet<string> = new Set(ALL_STAT_IDS);

export function isValidStatId(id: string): id is StatId {
  return VALID_STAT_IDS.has(id);
}

export interface StatClamp {
  readonly min?: number;
  readonly max?: number;
}

export const STAT_CLAMPS: Readonly<Record<StatId, StatClamp>> = {
  strength: { min: 0 },
  dexterity: { min: 0 },
  constitution: { min: 0 },
  intelligence: { min: 0 },
  wisdom: { min: 0 },
  charisma: { min: 0 },
  luck: { min: 0 },
  armor: { min: 0 },
  damageBonus: {},
  attackSpeed: { min: 0.1 },
  moveSpeed: { min: 0 },
  critChance: { min: 0, max: 1 },
  critMultiplier: { min: 1 },
  dodgeChance: { min: 0, max: 0.75 },
  hpRegen: { min: 0 },
  xpBonus: { min: 0 },
  cooldownReduction: { min: 0, max: 0.8 },
};

export const DEFAULT_BASE_STATS: Readonly<Record<StatId, number>> = {
  strength: 1,
  dexterity: 1,
  constitution: 1,
  intelligence: 1,
  wisdom: 1,
  charisma: 1,
  luck: 1,
  armor: 0,
  damageBonus: 0,
  attackSpeed: 0,
  moveSpeed: 0,
  critChance: 0.05,
  critMultiplier: 1.5,
  dodgeChance: 0,
  hpRegen: 0,
  xpBonus: 0,
  cooldownReduction: 0,
};

/** Clamp a stat value to its defined range. */
export function clampStat(statId: StatId, value: number): number {
  const clamp = STAT_CLAMPS[statId];
  let v = value;
  if (clamp.min !== undefined) v = Math.max(clamp.min, v);
  if (clamp.max !== undefined) v = Math.min(clamp.max, v);
  return v;
}
