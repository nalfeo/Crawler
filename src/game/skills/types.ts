import type { StatKey } from '../../shared/stats.js';
import type { UsageMetric } from '../../shared/skills.js';
export {
  SKILL_NATURAL_CAP,
  SKILL_HARD_CAP,
  type UsageMetric,
  type SkillUsageEvent,
  type SkillState,
  type StatModifier,
  type PlayerLevel,
} from '../../shared/skills.js';

export type MilestoneEffect =
  | { type: 'stat_add'; stat: StatKey; value: number }
  | { type: 'stat_multiply'; stat: StatKey; value: number }
  | { type: 'extra_projectile'; count: number }
  | { type: 'aura'; radius: number; dpsPercentOfDamage: number };

export interface SkillMilestone {
  level: 5 | 10 | 15 | 20;
  name: string;
  description: string;
  effect: MilestoneEffect;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  category: 'combat' | 'defense' | 'utility';
  usageMetric: UsageMetric;
  /** Strictly increasing, length MUST equal SKILL_HARD_CAP (20). */
  usageThresholds: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  perLevelBonus: Partial<Record<StatKey, number>>;
  milestones: SkillMilestone[];
  flavorText?: string;
}
