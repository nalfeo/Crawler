import type { StatKey } from './stats.js';

export type CatalogEffect =
  | { type: 'stat_add'; stat: StatKey; value: number }
  | { type: 'stat_multiply'; stat: StatKey; value: number }
  | { type: 'extra_projectile'; count: number }
  | { type: 'aura'; radius: number; dpsPercentOfDamage: number }
  | { type: 'spell_fireball'; damagePercent: number; radiusTiles: number }
  | { type: 'spell_heal'; baseHeal: number }
  | { type: 'spell_pulse_shield'; knockbackForce: number; radiusTiles: number };
