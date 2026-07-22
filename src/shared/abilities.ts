import type { UsageMetric } from './skills.js';
import {
  parseGeneratedEquipmentInstanceId,
  type GeneratedEquipmentInstanceId,
} from './generated-equipment-types.js';

export const ACTIVE_ABILITY_SLOT_LIMIT = 10;
export const ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION = 'ability-grant-ownership/v1' as const;
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

export type LearnedAbilityGrantSourceId = `learned:${string}`;
export type SkillAbilityGrantSourceId = `skill:${string}:${number}`;
export type EquipmentGrantSourceId = `equipment:${GeneratedEquipmentInstanceId}:${number}`;
export type LegacyAbilityGrantSourceId = `legacy:${'active' | 'passive'}:${string}`;
export type AbilityGrantSourceId =
  | LearnedAbilityGrantSourceId
  | SkillAbilityGrantSourceId
  | EquipmentGrantSourceId
  | LegacyAbilityGrantSourceId;
export type AbilityGrantKind = 'active' | 'passive';

export interface AbilityGrantOwnership {
  readonly schemaVersion: typeof ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION;
  readonly activeSourcesByAbilityId: Map<string, Set<AbilityGrantSourceId>>;
  readonly passiveSourcesByAbilityId: Map<string, Set<AbilityGrantSourceId>>;
}

interface AbilityStateFields {
  learnedSpellIds: string[];
  equippedActiveAbilityIds: string[];
  /** All catalog-backed active ability IDs with at least one ownership source, including
   * abilities owned but not yet equipped (e.g. when the active slot cap was full at grant time).
   * Derived field — always populated by syncDerivedAbilityLists; may be absent on legacy objects. */
  ownedActiveAbilityIds?: string[];
  passiveAbilityIds: string[];
  cooldownByAbilityId: Map<string, number>;
  cooldownFramesByAbilityId: Map<string, number>;
  appliedPassiveAbilityIds: Set<string>;
}

export interface AbilityState extends AbilityStateFields {
  grantOwnership?: AbilityGrantOwnership;
}

export interface LegacyAbilityState extends AbilityState {
  grantOwnership?: undefined;
}

export interface SourceOwnedAbilityState extends AbilityState {
  grantOwnership: AbilityGrantOwnership;
}

export type AbilityStateLike = AbilityState;

const ABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const LEARNED_SOURCE_PATTERN = /^learned:[a-z0-9][a-z0-9-]*$/;
const SKILL_SOURCE_PATTERN = /^skill:[a-z0-9][a-z0-9-]*:([0-9]+)$/;
const EQUIPMENT_SOURCE_PATTERN = /^equipment:(gei:v1:[a-z0-9][a-z0-9._-]{0,127}:[0-9]+):([0-9]+)$/;
const LEGACY_SOURCE_PATTERN = /^legacy:(active|passive):[a-z0-9][a-z0-9-]*$/;

function requireAbilityId(value: string, label: string): string {
  if (!ABILITY_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase kebab-case id`);
  }
  return value;
}

export function learnedAbilityGrantSourceId(abilityId: string): LearnedAbilityGrantSourceId {
  return `learned:${requireAbilityId(abilityId, 'Ability id')}`;
}

export function skillAbilityGrantSourceId(
  skillId: string,
  milestoneLevel: number,
): SkillAbilityGrantSourceId {
  requireAbilityId(skillId, 'Skill id');
  if (!Number.isSafeInteger(milestoneLevel) || milestoneLevel < 0) {
    throw new Error('Skill milestone level must be a non-negative safe integer');
  }
  return `skill:${skillId}:${milestoneLevel}`;
}

function isValidSkillGrantSourceId(value: string): value is SkillAbilityGrantSourceId {
  const match = SKILL_SOURCE_PATTERN.exec(value);
  if (!match) return false;
  const milestoneLevel = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(milestoneLevel) && String(milestoneLevel) === match[1];
}

function isValidEquipmentGrantSourceId(value: string): value is EquipmentGrantSourceId {
  const match = EQUIPMENT_SOURCE_PATTERN.exec(value);
  if (!match) return false;
  if (parseGeneratedEquipmentInstanceId(match[1]!) === undefined) return false;
  const effectOrdinal = Number.parseInt(match[2]!, 10);
  return Number.isSafeInteger(effectOrdinal) && String(effectOrdinal) === match[2];
}

export function equipmentAbilityGrantSourceId(
  instanceId: GeneratedEquipmentInstanceId,
  effectOrdinal: number,
): EquipmentGrantSourceId {
  if (!Number.isSafeInteger(effectOrdinal) || effectOrdinal < 0) {
    throw new Error('Equipment effect ordinal must be a non-negative safe integer');
  }
  const sourceId = `equipment:${instanceId}:${effectOrdinal}` as EquipmentGrantSourceId;
  if (!isValidEquipmentGrantSourceId(sourceId)) {
    throw new Error(`Invalid generated equipment instance id: ${instanceId}`);
  }
  return sourceId;
}

export function legacyAbilityGrantSourceId(
  kind: AbilityGrantKind,
  abilityId: string,
): LegacyAbilityGrantSourceId {
  return `legacy:${kind}:${requireAbilityId(abilityId, 'Ability id')}`;
}

export function isAbilityGrantSourceId(value: string): value is AbilityGrantSourceId {
  return (
    LEARNED_SOURCE_PATTERN.test(value) ||
    isValidSkillGrantSourceId(value) ||
    isValidEquipmentGrantSourceId(value) ||
    LEGACY_SOURCE_PATTERN.test(value)
  );
}

export function createEmptyAbilityState(): AbilityState {
  return {
    learnedSpellIds: [],
    equippedActiveAbilityIds: [],
    passiveAbilityIds: [],
    cooldownByAbilityId: new Map(),
    cooldownFramesByAbilityId: new Map(),
    appliedPassiveAbilityIds: new Set(),
    activeAbilityGrantSources: new Map(),
    passiveAbilityGrantSources: new Map(),
  };
}
