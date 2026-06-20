/**
 * stat-display — human-facing labels, descriptions, and value formatting for the
 * gameplay stat keys (`STAT_KEYS`).
 *
 * Kept in `shared/` (no Phaser/DOM) so both the level-up overlay and labs render
 * stats consistently and the formatting is unit-testable.
 */
import { STAT_POINT_INCREMENT, type StatKey } from './stats.js';

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
};

/** Format a stat's current gameplay value using its configured precision. */
export function formatStatValue(stat: StatKey, value: number): string {
  return value.toFixed(STAT_DISPLAY[stat].decimals);
}

/** Per-point increment string, e.g. `+10` or `+0.10`, for tooltips/preview. */
export function formatStatIncrement(stat: StatKey): string {
  return `+${STAT_POINT_INCREMENT[stat].toFixed(STAT_DISPLAY[stat].decimals)}`;
}
