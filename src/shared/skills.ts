import type { StatKey } from './stats.js';

export const SKILL_NATURAL_CAP = 15;
export const SKILL_HARD_CAP = 20;

export type UsageMetric =
  | 'hits_landed'
  | 'damage_dealt'
  | 'distance_dodged_near_threat'
  /**
   * Emitted by melee/projectile/beam/area-damage systems when a player attack
   * deals damage to an enemy. Skills only advance on hit — misses grant no XP.
   */
  | 'weapon_fired';

export interface SkillUsageEvent {
  holderEid?: number;
  skillId: string;
  metric: UsageMetric;
  amount: number;
}

export interface SkillState {
  level: number;
  usage: number;
  itemBonus: number;
  triggeredMilestones: Set<number>;
}

export interface StatModifier {
  sourceType: 'skill' | 'floor' | 'buff' | 'ability';
  sourceId: string;
  stat: StatKey;
  op: 'add' | 'multiply';
  value: number;
  expiresFrame?: number;
}

export interface PlayerLevel {
  xp: number;
  level: number;
  unspentPoints: number;
  pointsPerLevel: number;
}
