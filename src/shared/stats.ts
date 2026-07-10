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
  'weight',
] as const;

export const SECONDARY_STATS = [
  'armor',
  'damageBonus',
  'damagePercent',
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
  weight: { min: 0 },
  armor: { min: 0 },
  damageBonus: {},
  damagePercent: { min: 0 },
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
  weight: 1,
  armor: 0,
  damageBonus: 0,
  damagePercent: 0,
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

// --- Gameplay stat keys (used by Stats/StatPoints components) ---

/** Stat key definitions, base values, and per-point increments. */

export const STAT_KEYS = [
  'maxHp',
  'moveSpeed',
  'damage',
  'armor',
  'attackSpeed',
  'pickupRange',
  'projectileCount',
  'projectileSpeed',
  /**
   * Accuracy bonus stacked on top of a weapon's baseAccuracy.
   * Derived from dexterity (+0.01/point) and weapon type skills (+0.03/level).
   * Applied in weaponSystem: effectiveAccuracy = clamp(0,1, def.baseAccuracy + accuracy).
   */
  'accuracy',
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

/** Base stat values for a fresh player. */
export const STAT_BASE: Record<StatKey, number> = {
  maxHp: 100,
  moveSpeed: 0.375,
  damage: 10,
  armor: 0,
  attackSpeed: 1.0,
  pickupRange: 3.0,
  projectileCount: 0,
  projectileSpeed: 1.0,
  /** Accuracy bonus — added to weapon's baseAccuracy. Starts at 0. */
  accuracy: 0,
};

/** How much each stat point adds to this stat. */
export const STAT_POINT_INCREMENT: Record<StatKey, number> = {
  maxHp: 10,
  moveSpeed: 0.0125,
  damage: 2,
  armor: 1,
  attackSpeed: 0.05,
  pickupRange: 1.0,
  projectileCount: 1,
  projectileSpeed: 0.05,
  /**
   * Direct stat-point allocation to accuracy is not currently exposed in the
   * level-up UI (accuracy is trained via weapon type skills + dexterity).
   * This entry satisfies the Record<StatKey> constraint; the value is reserved
   * for any future direct-allocation path. Keep this in sync with dexterity's
   * per-point accuracy contribution in CORE_STAT_GAINS.
   */
  accuracy: 0.01,
};

/** Minimum clamped value for each stat. */
export const STAT_MIN: Record<StatKey, number> = {
  maxHp: 1,
  moveSpeed: 0,
  damage: 0,
  armor: 0,
  attackSpeed: 0.1,
  pickupRange: 1.0,
  projectileCount: 0,
  projectileSpeed: 0.1,
  accuracy: 0,
};

// --- Core stat (primary stat) to gameplay stat derivation ---

/**
 * How many points each PRIMARY_STAT starts with at character creation.
 * Used for display in the level-up UI ("you have X points in Strength").
 */
export const CORE_STAT_BASE: Readonly<Record<PrimaryStatId, number>> = {
  strength: 0,
  dexterity: 0,
  constitution: 0,
  intelligence: 0,
  wisdom: 0,
  charisma: 0,
  luck: 0,
  weight: 0,
};

const ALLOCATABLE_PRIMARY_STATS = [
  'strength',
  'dexterity',
  'constitution',
  'intelligence',
  'wisdom',
  'luck',
] as const satisfies readonly PrimaryStatId[];

const ALLOCATABLE_PRIMARY_STATS_SET: ReadonlySet<PrimaryStatId> = new Set(
  ALLOCATABLE_PRIMARY_STATS,
);

export function isAllocatablePrimaryStat(stat: PrimaryStatId): boolean {
  return ALLOCATABLE_PRIMARY_STATS_SET.has(stat);
}

/**
 * Per-point contribution of each PRIMARY_STAT to STAT_KEYS gameplay stats.
 *
 * When `statsSystem` recomputes, it sums:
 *   STAT_BASE[key] + (Σ coreStatPoints[p] × CORE_STAT_GAINS[p][key]) + modifiers
 *
 * Stats not listed here (charisma, weight) are reserved for future systems
 * (XP multiplier/NPC relations, momentum interactions) that do not yet have
 * STAT_KEYS entries.
 */
export const CORE_STAT_GAINS: Readonly<Record<PrimaryStatId, Partial<Record<StatKey, number>>>> = {
  /** Strength: raw damage output and physical resilience. */
  strength: { damage: 2, armor: 1 },
  /** Dexterity: speed of attack, foot movement, and weapon accuracy. */
  dexterity: { attackSpeed: 0.05, moveSpeed: 0.0125, accuracy: 0.01 },
  /** Constitution: health pool depth. */
  constitution: { maxHp: 10 },
  /** Intelligence: projectile control and arcane precision. */
  intelligence: { projectileSpeed: 0.05 },
  /** Wisdom: reserved — will gate mana pool / cooldown reduction. */
  wisdom: {},
  /** Charisma: reserved — will affect XP gain and NPC prices. */
  charisma: {},
  /** Luck: item magnetism and fortune. */
  luck: { pickupRange: 0.5 },
  /** Weight: reserved for future momentum/knockback interactions. */
  weight: {},
};

/**
 * Per-point contribution of each PRIMARY_STAT to SECONDARY (effectiveStats)
 * stats. Applied during effective-stat computation
 * (see `core/effective-stats.ts`): each effective primary stat
 * contributes `value × rate` to the listed secondary.
 *
 * This is the bridge that lets level-up core-stat allocation reach combat —
 * e.g. Luck raises crit chance and Dexterity raises dodge chance, both of which
 * the damage path reads from the player's EffectiveStats.
 *
 * Rates are per *point* of the effective primary (which already folds in the
 * base value of 1, allocated level-up points, and equipment bonuses).
 */
export const CORE_STAT_TO_SECONDARY: Readonly<
  Record<PrimaryStatId, Partial<Record<SecondaryStatId, number>>>
> = {
  /** Strength: offensive pressure — bonus damage multiplier. */
  strength: { damagePercent: 0.01 },
  /** Dexterity: nimbleness — chance to fully avoid an incoming hit. */
  dexterity: { dodgeChance: 0.003 },
  constitution: {},
  intelligence: {},
  /** Wisdom: focus — faster ability/skill cooldown recovery. */
  wisdom: { cooldownReduction: 0.005 },
  charisma: {},
  /** Luck: fortune — chance for an outgoing hit to critically strike. */
  luck: { critChance: 0.005 },
  weight: {},
};
