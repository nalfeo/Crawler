import type { StatKey } from './stats.js';

export type TimedBuffModifier = {
  stat: StatKey;
  op: 'add' | 'multiply';
  value: number;
};

export type CatalogEffect =
  | { type: 'stat_add'; stat: StatKey; value: number }
  | { type: 'stat_multiply'; stat: StatKey; value: number }
  | { type: 'extra_projectile'; count: number }
  | { type: 'aura'; radius: number; dpsPercentOfDamage: number }
  | { type: 'spell_fireball'; damagePercent: number; radiusTiles: number }
  | { type: 'spell_heal'; baseHeal: number }
  | { type: 'spell_pulse_shield'; knockbackForce: number; radiusTiles: number }
  | { type: 'spell_magic_missile'; damagePercent: number; rangeTiles: number }
  | {
      type: 'spell_frost_nova';
      damagePercent: number;
      radiusTiles: number;
      slowMultiplier: number;
      slowDurationMs: number;
    }
  | {
      type: 'spell_timed_buff';
      durationFrames: number;
      modifiers: TimedBuffModifier[];
      vfxColor?: number;
    }
  | {
      type: 'spell_enemy_slow_burst';
      radiusTiles: number;
      slowMultiplier: number;
      slowDurationMs: number;
      vfxColor?: number;
    }
  | {
      type: 'spell_life_drain';
      damagePercent: number;
      rangeTiles: number;
      healPercent: number;
    };
