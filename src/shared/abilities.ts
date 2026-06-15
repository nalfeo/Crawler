import type { UsageMetric } from './skills.js';

export const ACTIVE_ABILITY_SLOT_LIMIT = 10;

export type AbilityTriggerKind =
  | 'skill_usage'
  | 'enemy_cluster'
  | 'low_health'
  | 'low_health_crowded'
  | 'health_deficit_at_least';

export type AbilityTriggerCondition =
  | {
      kind: 'skill_usage';
      metric?: UsageMetric;
      skillId?: string;
      minAmount?: number;
    }
  | {
      kind: 'enemy_cluster';
      minEnemies: number;
      withinFeet: number;
    }
  | {
      kind: 'low_health';
      healthBelowRatio: number;
    }
  | {
      kind: 'low_health_crowded';
      healthBelowRatio: number;
      minEnemies: number;
      withinFeet: number;
    }
  | {
      kind: 'health_deficit_at_least';
      deficitAmount: number;
    };

export interface AbilityTriggerEvent {
  holderEid?: number;
  kind: 'skill_usage';
  metric?: UsageMetric;
  skillId?: string;
  amount?: number;
}

export interface AbilityState {
  equippedActiveAbilityIds: string[];
  passiveAbilityIds: string[];
  cooldownByAbilityId: Map<string, number>;
  appliedPassiveAbilityIds: Set<string>;
}
