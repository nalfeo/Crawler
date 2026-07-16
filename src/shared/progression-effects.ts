import type { StatKey, ScalableOutput } from './stats.js';

export type TimedBuffModifier = {
  stat: StatKey;
  op: 'add' | 'multiply';
  value: ScalableOutput;
};

/**
 * Every magical ability's numeric output is inline `{ base, scalesWithIntelligence }`
 * (see `shared/stats.ts#ScalableOutput`) so each field explicitly declares its
 * own scaling — including damage, healing, duration, radius, knockback, and
 * slow amounts. Resolved once through `resolveScalableOutput`/
 * `resolveScalableOutputRounded` at cast time (see `game/systems/progressionEffects.ts`).
 */
export type CatalogEffect =
  | { type: 'stat_add'; stat: StatKey; value: number }
  | { type: 'stat_multiply'; stat: StatKey; value: number }
  | { type: 'extra_projectile'; count: number }
  | { type: 'aura'; radius: number; dpsPercentOfDamage: number }
  | { type: 'spell_fireball'; damage: ScalableOutput; radiusTiles: ScalableOutput }
  | { type: 'spell_heal'; heal: ScalableOutput }
  | { type: 'spell_pulse_shield'; knockbackForce: ScalableOutput; radiusTiles: ScalableOutput }
  | { type: 'spell_magic_missile'; damage: ScalableOutput; rangeTiles: ScalableOutput }
  | {
      type: 'spell_frost_nova';
      damage: ScalableOutput;
      radiusTiles: ScalableOutput;
      slowMultiplier: ScalableOutput;
      slowDurationMs: ScalableOutput;
    }
  | {
      type: 'spell_timed_buff';
      durationFrames: ScalableOutput;
      modifiers: TimedBuffModifier[];
      vfxColor?: number;
    }
  | {
      type: 'spell_enemy_slow_burst';
      radiusTiles: ScalableOutput;
      slowMultiplier: ScalableOutput;
      slowDurationMs: ScalableOutput;
      vfxColor?: number;
    }
  | {
      type: 'spell_life_drain';
      damage: ScalableOutput;
      rangeTiles: ScalableOutput;
      heal: ScalableOutput;
    };
