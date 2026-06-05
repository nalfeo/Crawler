import type { UsageMetric } from './skills.js';

export const ACTIVE_ABILITY_SLOT_LIMIT = 10;

export type AbilityTriggerKind = 'manual' | 'skill_usage';

export interface AbilityTriggerCondition {
  kind: AbilityTriggerKind;
  metric?: UsageMetric;
  skillId?: string;
  minAmount?: number;
}

export interface AbilityTriggerEvent {
  holderEid?: number;
  kind: AbilityTriggerKind;
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
