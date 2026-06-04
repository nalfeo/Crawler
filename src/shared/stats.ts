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
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

/** Base stat values for a fresh player. */
export const STAT_BASE: Record<StatKey, number> = {
  maxHp: 100,
  moveSpeed: 3.0,
  damage: 10,
  armor: 0,
  attackSpeed: 1.0,
  pickupRange: 24,
  projectileCount: 0,
  projectileSpeed: 1.0,
};

/** How much each stat point adds to this stat. */
export const STAT_POINT_INCREMENT: Record<StatKey, number> = {
  maxHp: 10,
  moveSpeed: 0.1,
  damage: 2,
  armor: 1,
  attackSpeed: 0.05,
  pickupRange: 8,
  projectileCount: 1,
  projectileSpeed: 0.05,
};

/** Minimum clamped value for each stat. */
export const STAT_MIN: Record<StatKey, number> = {
  maxHp: 1,
  moveSpeed: 0,
  damage: 0,
  armor: 0,
  attackSpeed: 0.1,
  pickupRange: 8,
  projectileCount: 0,
  projectileSpeed: 0.1,
};
