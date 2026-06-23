/**
 * stat-display — human-facing labels, descriptions, and value formatting for the
 * gameplay stat keys (`STAT_KEYS`) and primary (core) stats (`PRIMARY_STATS`).
 *
 * Kept in `shared/` (no Phaser/DOM) so both the level-up overlay and labs render
 * stats consistently and the formatting is unit-testable.
 */
import {
  STAT_POINT_INCREMENT,
  type StatKey,
  type PrimaryStatId,
  CORE_STAT_GAINS,
} from './stats.js';

export interface StatDisplayInfo {
  /** Short title shown in the allocation row. */
  readonly label: string;
  /** One-line explanation of what the stat does. */
  readonly description: string;
  /** Decimal places to show for the stat's gameplay value. */
  readonly decimals: number;
}

export const STAT_DISPLAY: Readonly<Record<StatKey, StatDisplayInfo>> = {
  maxHp: {
    label: 'Max HP',
    description: 'Maximum health pool. Each point heals you on the spot.',
    decimals: 0,
  },
  moveSpeed: {
    label: 'Move Speed',
    description: 'How quickly you move around the floor.',
    decimals: 1,
  },
  damage: {
    label: 'Damage',
    description: 'Bonus damage added to your attacks.',
    decimals: 0,
  },
  armor: {
    label: 'Armor',
    description: 'Flat damage reduction on every hit you take.',
    decimals: 0,
  },
  attackSpeed: {
    label: 'Attack Speed',
    description: 'How fast you attack — higher fires sooner.',
    decimals: 2,
  },
  pickupRange: {
    label: 'Pickup Range',
    description: 'Radius for vacuuming up loot and XP.',
    decimals: 0,
  },
  projectileCount: {
    label: 'Projectiles',
    description: 'Extra projectiles loosed per ranged attack.',
    decimals: 0,
  },
  projectileSpeed: {
    label: 'Projectile Speed',
    description: 'How fast your projectiles travel.',
    decimals: 2,
  },
  accuracy: {
    label: 'Accuracy',
    description:
      "Bonus hit chance added to your weapon's base accuracy. Trained via weapon type skills and dexterity.",
    decimals: 2,
  },
};

/** Format a stat's current gameplay value using its configured precision. */
export function formatStatValue(stat: StatKey, value: number): string {
  return value.toFixed(STAT_DISPLAY[stat].decimals);
}

/** Per-point increment string, e.g. `+10` or `+0.10`, for tooltips/preview. */
export function formatStatIncrement(stat: StatKey): string {
  return `+${STAT_POINT_INCREMENT[stat].toFixed(STAT_DISPLAY[stat].decimals)}`;
}

/** Human-readable display metadata for each primary (core) stat. */
export const PRIMARY_STAT_DISPLAY: Readonly<Record<PrimaryStatId, StatDisplayInfo>> = {
  strength: {
    label: 'Strength',
    description: '+2 Damage · +1 Armor per point. Melee power and physical resilience.',
    decimals: 0,
  },
  dexterity: {
    label: 'Dexterity',
    description:
      '+0.05 Attack Speed · +0.1 Move Speed · +0.01 Accuracy per point. Agility and precision.',
    decimals: 0,
  },
  constitution: {
    label: 'Constitution',
    description: '+10 Max HP per point. Endurance and survivability.',
    decimals: 0,
  },
  intelligence: {
    label: 'Intelligence',
    description: '+0.05 Projectile Speed per point. Arcane focus and precision.',
    decimals: 0,
  },
  wisdom: {
    label: 'Wisdom',
    description: 'Reserved — will expand mana pool and cooldown reduction.',
    decimals: 0,
  },
  charisma: {
    label: 'Charisma',
    description: 'Reserved — will boost XP gain and improve NPC relations.',
    decimals: 0,
  },
  luck: {
    label: 'Luck',
    description: '+4 Pickup Range per point. Fortune and item magnetism.',
    decimals: 0,
  },
};

/**
 * Format the derived gains for a primary stat as a compact summary, e.g.
 * `"+2 dmg, +1 armor"`. Returns `"(no effect yet)"` for stats with empty gains.
 */
export function formatCoreStatGains(stat: PrimaryStatId): string {
  const gains = CORE_STAT_GAINS[stat];
  const parts: string[] = [];
  for (const [key, value] of Object.entries(gains) as [StatKey, number][]) {
    const decimals = STAT_DISPLAY[key].decimals;
    parts.push(`+${value.toFixed(decimals)} ${STAT_DISPLAY[key].label}`);
  }
  return parts.length > 0 ? parts.join(', ') : '(no effect yet)';
}
