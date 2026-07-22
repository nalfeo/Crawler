import type { UsageMetric } from './skills.js';
import type { EquipmentInstanceId } from './equipment-types.js';
import type { GeneratedEquipmentInstanceId } from './generated-equipment-types.js';

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

/**
 * Identifies where an ability grant originated. Used by source-tracking maps
 * in `AbilityState` so revocation targets only the matching source and never
 * accidentally removes grants from other origins.
 *
 * - `learned`:              Player learned/memorized the ability directly (boss reward spell,
 *                           lab grant, etc.). These grants are never auto-revoked.
 * - `skill`:                A skill-milestone (e.g. level-5) automatically granted the
 *                           passive. Revoked if the skill is somehow reset (future work);
 *                           preserved when equipment sources are removed.
 * - `equipment`:            An equipped item instance granted the ability. `instanceId` is
 *                           the stable numeric `EquipmentInstanceId` for static items or the
 *                           `GeneratedEquipmentInstanceId` string for generated items.
 *                           Revoked atomically when that equipment instance is unequipped.
 * - `generated-equipment`:  A Floor 2 generated-equipment instance granted the ability via
 *                           `grantGeneratedEquipmentActiveAbility` /
 *                           `grantGeneratedEquipmentPassiveAbility`. Carries `effectOrdinal`
 *                           so each effect from the same instance has a distinct, idempotent
 *                           identity (prevents duplicate source entries when the grant
 *                           wrapper is called more than once). Revoked atomically by
 *                           `revokeEquipmentAbilityGrants`.
 */
export type AbilityGrantSource =
  | { readonly kind: 'learned' }
  | { readonly kind: 'skill'; readonly skillId: string }
  | {
      readonly kind: 'equipment';
      readonly instanceId: EquipmentInstanceId | GeneratedEquipmentInstanceId;
    }
  | {
      readonly kind: 'generated-equipment';
      readonly instanceId: GeneratedEquipmentInstanceId;
      readonly effectOrdinal: number;
    };

export interface AbilityState {
  learnedSpellIds: string[];
  equippedActiveAbilityIds: string[];
  passiveAbilityIds: string[];
  cooldownByAbilityId: Map<string, number>;
  cooldownFramesByAbilityId: Map<string, number>;
  appliedPassiveAbilityIds: Set<string>;
  /**
   * Source-tracking for equipped active abilities. Maps each `abilityId` in
   * `equippedActiveAbilityIds` to the ordered list of `AbilityGrantSource`
   * records that granted it. An ability with multiple sources (e.g. the same
   * active granted by two different equipment pieces) stays equipped until all
   * its sources are removed. Absence of an entry is the backward-compat
   * migration path: the ability is treated as `learned`.
   */
  activeAbilityGrantSources: Map<string, AbilityGrantSource[]>;
  /**
   * Source-tracking for passive abilities. Same semantics as
   * `activeAbilityGrantSources` — each entry in `passiveAbilityIds` maps to the
   * list of sources that granted it. Removing a single equipment source only
   * removes the ability from `passiveAbilityIds` when no other sources remain.
   */
  passiveAbilityGrantSources: Map<string, AbilityGrantSource[]>;
}
