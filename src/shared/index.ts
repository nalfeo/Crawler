export {
  GAME,
  CORPSE,
  FLOOR,
  PLAYER_SPEED,
  SAFE_ROOM,
  WEAPON,
  WeaponType,
  TeamId,
  XP,
  FLOOR1_SPELL_BROKER_COST,
} from './constants.js';
export type { WeaponTypeValue, TeamIdValue } from './constants.js';
export { createInputState, normalizeInputDirection } from './input.js';
export type { InputState } from './input.js';
export { SeededRandom } from './random.js';
export { WEAPON_DEFS, getWeaponDef } from './weaponDefs.js';
export type { WeaponDef } from './weaponDefs.js';
export {
  FLOOR2_WEAPON_WAVE_A_BASES,
  FLOOR2_WEAPON_WAVE_A_BASE_IDS,
  getFloor2WeaponWaveABase,
} from './data/floor2-weapon-bases.js';
export type {
  Floor2WeaponBaseDefinition,
  Floor2WeaponBaseFamily,
} from './data/floor2-weapon-bases.js';
export { MOB_DEFS, getMobDef } from './mobDefs.js';
export type { MobDef } from './mobDefs.js';
export { TILE_DEFS, getTileDef, getTilesByBiome } from './tileDefs.js';
export type { TileDef, Collider, Passability } from './tileDefs.js';
export { DECORATION_DEFS, getDecorationDef, getDecorationsByBiome } from './decorationDefs.js';
export type { DecorationDef, DepthLayer } from './decorationDefs.js';
export type { BiomeTag } from './biome-tags.js';
export { SLOT_REGISTRY, VALID_SLOT_IDS, isValidSlotId, getSlotLabel } from './equipment-slots.js';
export type { SlotDefinition, EquipmentSlotId } from './equipment-slots.js';
// Side-effect import: throws at load time if mirror-slot metadata is inconsistent.
import './mirror-slot-metadata.js';
export {
  PRIMARY_STATS,
  SECONDARY_STATS,
  ALL_STAT_IDS,
  VALID_STAT_IDS,
  isValidStatId,
  STAT_CLAMPS,
  DEFAULT_BASE_STATS,
  clampStat,
} from './stats.js';
export type { PrimaryStatId, SecondaryStatId, StatId, StatClamp } from './stats.js';
export type {
  ItemRarity,
  EquipRequirement,
  EquipmentItemDef,
  EquipmentInstanceId,
  EquipmentInstance,
  EquipmentState,
  EquipFailureReason,
  EquipResult,
  UnequipResult,
  CanEquipResult,
} from './equipment-types.js';
export {
  GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_BASE_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_GENERATION_POLICY_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_REGISTRY_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
  generatedEquipmentRunKeyFromSeed,
} from './generated-equipment-types.js';
export type {
  GeneratedEquipmentInstanceId,
  GeneratedEquipmentInstanceKey,
  EquipmentGrantSourceId,
  EquipmentFingerprintV1,
  GeneratedEquipmentRarity,
  GeneratedEquipmentEnhancementLevel,
  GeneratedEquipmentEffectUnitCost,
  GeneratedEquipmentBaseV1,
  ResolvedEquipmentStatEffectV1,
  ResolvedEquipmentGrantEffectV1,
  ResolvedEquipmentEffectV1,
  ActiveWeaponSnapshotV1,
  FrozenEquipmentFieldsV1,
  GeneratedEquipmentGenerationPolicyV1,
  GeneratedEquipmentGenerationV1,
  GeneratedEquipmentInstanceV1,
  GeneratedEquipmentCreateInputV1,
  GeneratedEquipmentRegistrySnapshotV1,
  GeneratedEquipmentRewardBundleV1,
  ActiveWeaponCombatOverridesV1,
  ActiveWeaponSnapshotCreateInputV1,
  FrozenEquipmentFieldsCreateInputV1,
} from './generated-equipment-types.js';
export { CanonicalJsonError, canonicalJson, sha256Hex, deepFreeze } from './canonical-json.js';
export {
  ENCUMBRANCE_THRESHOLD_BASE_LB,
  ENCUMBRANCE_STR_THRESHOLD_BONUS_LB_PER_POINT,
  ENCUMBRANCE_BAND_MULTIPLIER,
  computeEncumbranceThresholds,
  computeEncumbranceBand,
  computeEncumbranceMultiplier,
  computeEncumbranceMultiplierForMass,
} from './encumbrance.js';
export type { EncumbranceBand, EncumbranceThresholds } from './encumbrance.js';
export type {
  StatusEffectStat,
  StatusEffectOp,
  StatusEffectSourceType,
  StackRule,
  StatusEffectSpec,
  StatusEffectClamps,
  StatusEffect,
} from './status-effect-types.js';
export {
  STAT_KEYS,
  CORE_STAT_BASE,
  CORE_STAT_TO_SECONDARY,
  isAllocatablePrimaryStat,
  foldLegacyStatModifier,
  computeTypedPrimaryMultiplier,
  resolveScalableOutput,
  resolveScalableOutputRounded,
  applyCooldownReduction,
  applyAttackSpeedAndCooldownReduction,
  STR_PHYSICAL_DAMAGE_RATE,
  INT_MAGIC_STRENGTH_RATE,
  ATTACK_SPEED_BONUS_MIN_CLAMP,
} from './stats.js';
export type { StatKey, ScalableOutput, DamageAffinity, LegacyStatModifierLike } from './stats.js';
export { xpThresholdForLevel, xpRequiredForLevel, levelForXp } from './xpMath.js';
export { SKILL_NATURAL_CAP, SKILL_HARD_CAP } from './skills.js';
export type {
  PlayerLevel,
  StatModifier,
  SkillState,
  SkillUsageEvent,
  UsageMetric,
} from './skills.js';
export {
  SPELL_SKILL_ID_BY_SPELL_ID,
  getSpellSkillId,
  FLOOR1_SPELL_BROKER_OFFER_COUNT,
  generateFloor1SpellBrokerOffers,
} from './spell-skills.js';
export * from './items.js';
export * from './inventory.js';
export {
  DEFAULT_HANDHELD_SPRITE_ANCHOR,
  resolveHandheldAnchor,
  isValidAnchor,
} from './sprite-anchor.js';
export type { SpriteAnchor } from './sprite-anchor.js';
export {
  MAX_ACTIVE_QUESTS,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
  SHOPKEEPER_EQUIPMENT_ITEM_ID,
  getQuestDef,
  getAllQuestDefs,
  getQuestPacks,
  installQuestPacks,
  installDefaultQuestPacks,
  objectiveTarget,
  questPackSchema,
} from './quest-types.js';
export type {
  QuestObjectiveKind,
  QuestObjectiveDef,
  QuestDef,
  QuestStatus,
  QuestState,
  QuestPackDef,
  QuestPackQuestSource,
  QuestTemplateKind,
  QuestTemplateDef,
  GoalFlagTemplateDef,
  KillTargetsTemplateDef,
  FetchAndEquipTemplateDef,
  ShopkeeperStage,
} from './quest-types.js';
export type {
  QuestEvent,
  QuestCounterSetEvent,
  QuestCounterAddEvent,
  QuestNpcTalkEvent,
} from './quest-events.js';
export {
  MERCHANTS_CHARM_DEF,
  MERCHANTS_CHARM_COST,
  getEquipmentDefForItem,
  isEquippableItem,
  getEquippableItemIds,
} from './equipmentDefs.js';
export * from './achievements.js';
export {
  FLOOR2_BOSS_ABILITY_CATALOG,
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityByBossId,
  getFloor2BossAbilityById,
  loadFloor2BossAbilityCatalog,
  toBossAbilityCodexEntry,
} from './boss-abilities.js';
export type {
  BossAbilityCatalog,
  BossAbilityCodexEntry,
  BossAbilityDef,
} from './boss-abilities.js';
export {
  VEC_EPSILON,
  length,
  distance,
  distanceSq,
  normalize,
  type NormalizedVector,
} from './vec.js';
