import type { UsageMetric } from './skills.js';

export const ACTIVE_ABILITY_SLOT_LIMIT = 10;
export const FLOOR1_BOSS_REWARD_SPELL_OFFER_COUNT = 3;
export const FLOOR1_BOSS_REWARD_SPELL_IDS = [
  'fireball',
  'heal',
  'pulse-shield',
  'magic-missile',
  'frost-nova',
  'bless',
  'stoneskin',
  'curse',
  'vampiric-touch',
  'haste',
] as const;
export type Floor1BossRewardSpellId = (typeof FLOOR1_BOSS_REWARD_SPELL_IDS)[number];

/**
 * Deterministic default reward spell, granted by the safe fallback
 * (`ensureBossBattleSpellReward`) when the boss-battle quest is complete but no
 * spell was chosen via the modal or AI auto-progression. `heal` is chosen
 * deliberately: it matches the AI auto-progression pick and has no offensive
 * auto-cast, so a fallback grant never shifts the combat RNG trajectory.
 */
export const DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID: Floor1BossRewardSpellId = 'heal';

export type AbilityTriggerKind =
  'skill_usage' | 'enemy_cluster' | 'low_health' | 'low_health_crowded' | 'health_deficit_at_least';

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
  learnedSpellIds: string[];
  equippedActiveAbilityIds: string[];
  passiveAbilityIds: string[];
  cooldownByAbilityId: Map<string, number>;
  cooldownFramesByAbilityId: Map<string, number>;
  appliedPassiveAbilityIds: Set<string>;
}
