import type { StatKey } from '../../shared/stats.js';
import type { CatalogEffect } from '../../shared/progression-effects.js';
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

export type MilestoneEffect = CatalogEffect;

export interface SkillMilestone {
  level: 5 | 10 | 15 | 20;
  name: string;
  description: string;
  effect?: MilestoneEffect;
  abilityId?: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  category: 'combat' | 'defense' | 'utility';
  usageMetric: UsageMetric;
  usageThresholds: number[];
  perLevelBonus: Partial<Record<StatKey, number>>;
  milestones: SkillMilestone[];
  flavorText?: string;
}
