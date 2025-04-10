/**
 * stat-display — human-facing labels, descriptions, and value formatting for the
 * gameplay stat keys (`STAT_KEYS`) and primary (core) stats (`PRIMARY_STATS`).
 *
 * Kept in `shared/` (no Phaser/DOM) so both the level-up overlay and labs render
 * stats consistently and the formatting is unit-testable.
 */
import {
  type StatKey,
  type PrimaryStatId,
  type SecondaryStatId,
  CORE_STAT_TO_SECONDARY,
  STR_PHYSICAL_DAMAGE_RATE,
  INT_MAGIC_STRENGTH_RATE,
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
    decimals: 4,
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

/** Human-readable display metadata for each primary (core) stat. */
export const PRIMARY_STAT_DISPLAY: Readonly<Record<PrimaryStatId, StatDisplayInfo>> = {
  strength: {
    label: 'Strength',
    description: '+1.0% physical damage per effective point. Melee, ranged, and thrown power.',
    decimals: 0,
  },
  dexterity: {
    label: 'Dexterity',
    description:
      '+1.0% attack speed · +0.25% move speed · +0.25% accuracy · +0.33% dodge chance per effective point. Agility and precision.',
    decimals: 0,
  },
  constitution: {
    label: 'Constitution',
    description: '+10 Max HP per effective point. Endurance and survivability.',
    decimals: 0,
  },
  intelligence: {
    label: 'Intelligence',
    description: '+1.0% magic strength per effective point. Boosts spell and magic-weapon output.',
    decimals: 0,
  },
  wisdom: {
    label: 'Wisdom',
    description: '+0.5% cooldown reduction per effective point (cap 80%). Arcane focus.',
    decimals: 0,
  },
  charisma: {
    label: 'Charisma',
    description: 'Visible, no gameplay effect yet. Not allocatable.',
    decimals: 0,
  },
  luck: {
    label: 'Luck',
    description: '+0.25% crit chance per effective point (cap 100%). Fortune and item magnetism.',
    decimals: 0,
  },
};

/**
 * Display labels for the SECONDARY stats that core stats derive as percentage
 * rates (e.g. critChance 0.0025 → "+0.25% Crit Chance"). `maxHp` is a flat
 * value, not a rate, and is formatted separately in `formatSecondaryGain`.
 */
const SECONDARY_PERCENT_LABEL: Partial<Record<SecondaryStatId, string>> = {
  damagePercent: 'Damage',
  attackSpeed: 'Attack Speed',
  moveSpeed: 'Move Speed',
  critChance: 'Crit Chance',
  dodgeChance: 'Dodge Chance',
  cooldownReduction: 'Cooldown Reduction',
  accuracy: 'Accuracy',
};

/** Format a single derived secondary-stat gain for the level-up summary. */
function formatSecondaryGain(stat: SecondaryStatId, value: number): string {
  if (stat === 'maxHp') {
    return `+${value.toFixed(STAT_DISPLAY.maxHp.decimals)} ${STAT_DISPLAY.maxHp.label}`;
  }
  const label = SECONDARY_PERCENT_LABEL[stat];
  if (label !== undefined) {
    return `+${(value * 100).toFixed(2)}% ${label}`;
  }
  return `+${value} ${stat}`;
}

/**
 * Format the derived gains for a primary stat as a compact summary, e.g.
 * `"+10 Max HP"` or `"+0.25% Crit Chance"`. Combines the typed-primary rates
 * (Strength → physical damage, Intelligence → magic strength — see
 * `shared/stats.ts#computeTypedPrimaryMultiplier`) with the generic derived
 * secondary stats (`CORE_STAT_TO_SECONDARY`). Returns `"(no effect yet)"` for
 * stats with no gains in either (currently only Charisma).
 */
export function formatCoreStatGains(stat: PrimaryStatId): string {
  const parts: string[] = [];

  if (stat === 'strength') {
    parts.push(`+${(STR_PHYSICAL_DAMAGE_RATE * 100).toFixed(1)}% Physical Damage`);
  }
  if (stat === 'intelligence') {
    parts.push(`+${(INT_MAGIC_STRENGTH_RATE * 100).toFixed(1)}% Magic Strength`);
  }

  const secondary = CORE_STAT_TO_SECONDARY[stat];
  for (const [key, value] of Object.entries(secondary) as [SecondaryStatId, number][]) {
    parts.push(formatSecondaryGain(key, value));
  }

  return parts.length > 0 ? parts.join(', ') : '(no effect yet)';
}
