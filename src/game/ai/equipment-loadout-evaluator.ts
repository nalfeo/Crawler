import {
  computeArmorReducedDamage,
  computeEffectiveAccuracyFromValues,
  computeExpectedCritDamage,
  computePlayerScaledDamage,
} from '../../core/combat-math.js';
import { computeEffectiveStatsFromLoadout } from '../../core/effective-stats.js';
import { validateGeneratedEquipmentInstanceV1 } from '../../core/generated-equipment-registry.js';
import { getAbilityDefinition } from '../abilities/registry.js';
import type { AbilityDefinition } from '../abilities/types.js';
import { WeaponType } from '../../shared/constants.js';
import { deepFreeze } from '../../shared/canonical-json.js';
import {
  computeEncumbranceBand,
  computeEncumbranceMultiplier,
  computeEncumbranceThresholds,
} from '../../shared/encumbrance.js';
import { isValidSlotId } from '../../shared/equipment-slots.js';
import { ACTIVE_ABILITY_SLOT_LIMIT, type AbilityGrantSource } from '../../shared/abilities.js';
import type {
  ActiveWeaponSnapshotV1,
  GeneratedEquipmentInstanceV1,
} from '../../shared/generated-equipment-types.js';
import type { CatalogEffect } from '../../shared/progression-effects.js';
import {
  applyAttackSpeedAndCooldownReduction,
  applyCooldownReduction,
  resolveScalableOutput,
  resolveScalableOutputRounded,
  type LegacyStatModifierLike,
  type PrimaryStatId,
  type StatId,
} from '../../shared/stats.js';
import { weaponSkillPrerequisiteMatches } from '../../shared/weapon-skills.js';

export const EQUIPMENT_ERV_CONFIG_SCHEMA_VERSION = 'equipment-erv-config/v1' as const;

export type EquipmentErvComponent =
  | 'offense'
  | 'defense'
  | 'mobility'
  | 'activeAbility'
  | 'passiveAbility'
  | 'encounterFit'
  | 'affinity'
  | 'encumbrance'
  | 'purchaseCost';

export type EquipmentErvComponents = Readonly<Record<EquipmentErvComponent, number>>;

export interface EquipmentErvConfig {
  readonly schemaVersion: typeof EQUIPMENT_ERV_CONFIG_SCHEMA_VERSION;
  readonly framesPerSecond: number;
  readonly weights: Readonly<{
    offense: number;
    defense: number;
    mobility: number;
    activeAbility: number;
    passiveAbility: number;
    encounterFit: number;
    affinity: number;
    encumbrance: number;
    purchaseCost: number;
  }>;
}

export const DEFAULT_EQUIPMENT_ERV_CONFIG: EquipmentErvConfig = deepFreeze({
  schemaVersion: EQUIPMENT_ERV_CONFIG_SCHEMA_VERSION,
  framesPerSecond: 60,
  weights: {
    offense: 1,
    defense: 0.25,
    mobility: 1,
    activeAbility: 1,
    passiveAbility: 1,
    encounterFit: 1,
    affinity: 1,
    encumbrance: 1,
    purchaseCost: 1,
  },
});

export interface EquipmentEncounterFixture {
  readonly id: string;
  readonly durationSeconds: number;
  readonly enemyCount: number;
  readonly clusteredEnemyCount: number;
  readonly incomingHitDamage: number;
  readonly incomingHitsPerSecond: number;
  readonly lowHealthUptime: number;
  readonly skillTriggerRatePerSecond: number;
}

export interface EquipmentLoadoutSnapshot {
  readonly equipped: readonly GeneratedEquipmentInstanceV1[];
  readonly baseStats: Readonly<Partial<Record<StatId, number>>>;
  readonly coreStatPoints: Readonly<Partial<Record<PrimaryStatId, number>>>;
  readonly activeAbilityGrantSources: ReadonlyMap<string, readonly AbilityGrantSource[]>;
  readonly passiveAbilityGrantSources: ReadonlyMap<string, readonly AbilityGrantSource[]>;
  readonly equippedActiveAbilityIds: readonly string[];
  readonly bodyWeightLb: number;
}

export interface EquipmentLoadoutCandidate {
  readonly instance: GeneratedEquipmentInstanceV1;
  readonly source: 'equipped' | 'inventory' | 'shop';
  readonly purchaseCost: number;
}

export interface EvaluateEquipmentLoadoutInput {
  readonly current: EquipmentLoadoutSnapshot;
  readonly candidates: readonly EquipmentLoadoutCandidate[];
  readonly remainingEncounters: readonly EquipmentEncounterFixture[];
  readonly affinityTagWeights: Readonly<Record<string, number>>;
  readonly config?: EquipmentErvConfig;
}

export interface EquipmentLoadoutScore {
  readonly total: number;
  readonly components: EquipmentErvComponents;
  readonly effectiveStats: Readonly<Record<StatId, number>>;
  readonly equippedActiveAbilityIds: readonly string[];
  readonly availablePassiveAbilityIds: readonly string[];
  readonly activeWeaponInstanceId: string | null;
}

export interface EquipmentLoadoutEvaluation {
  readonly candidate: EquipmentLoadoutCandidate;
  readonly score: number;
  readonly currentScore: EquipmentLoadoutScore;
  readonly nextScore: EquipmentLoadoutScore;
  readonly components: EquipmentErvComponents;
  readonly candidateContribution: number;
  readonly displacementCost: number;
  readonly displacedInstanceIds: readonly string[];
  readonly configuredActiveAbilityIds: readonly string[];
  readonly blockedActiveAbilityIds: readonly string[];
}

export interface RejectedEquipmentLoadoutCandidate {
  readonly candidate: EquipmentLoadoutCandidate;
  readonly reasons: readonly string[];
}

export interface EquipmentLoadoutEvaluationResult {
  readonly ranked: readonly EquipmentLoadoutEvaluation[];
  readonly rejected: readonly RejectedEquipmentLoadoutCandidate[];
}

export class EquipmentLoadoutEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EquipmentLoadoutEvaluationError';
  }
}

type MutableOwnership = {
  active: Map<string, AbilityGrantSource[]>;
  passive: Map<string, AbilityGrantSource[]>;
};

interface LoadoutScoringState {
  readonly equipped: readonly GeneratedEquipmentInstanceV1[];
  readonly ownership: MutableOwnership;
  readonly equippedActiveAbilityIds: readonly string[];
}

const COMPONENTS: readonly EquipmentErvComponent[] = [
  'offense',
  'defense',
  'mobility',
  'activeAbility',
  'passiveAbility',
  'encounterFit',
  'affinity',
  'encumbrance',
  'purchaseCost',
];

function emptyComponents(): Record<EquipmentErvComponent, number> {
  return {
    offense: 0,
    defense: 0,
    mobility: 0,
    activeAbility: 0,
    passiveAbility: 0,
    encounterFit: 0,
    affinity: 0,
    encumbrance: 0,
    purchaseCost: 0,
  };
}

function sumComponents(components: EquipmentErvComponents): number {
  return COMPONENTS.reduce((sum, component) => sum + components[component], 0);
}

function requireFinite(value: number, path: string, minimum?: number): void {
  if (!Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new EquipmentLoadoutEvaluationError(
      `${path} must be a finite number${minimum === undefined ? '' : ` >= ${minimum}`}`,
    );
  }
}

function validateConfig(config: EquipmentErvConfig): void {
  if (config.schemaVersion !== EQUIPMENT_ERV_CONFIG_SCHEMA_VERSION) {
    throw new EquipmentLoadoutEvaluationError(
      `Unsupported ERV config version ${config.schemaVersion}`,
    );
  }
  requireFinite(config.framesPerSecond, '$.config.framesPerSecond', 1);
  for (const component of COMPONENTS) {
    requireFinite(config.weights[component], `$.config.weights.${component}`, 0);
  }
}

function validateEncounter(fixture: EquipmentEncounterFixture, index: number): void {
  if (fixture.id.trim().length === 0) {
    throw new EquipmentLoadoutEvaluationError(`$.remainingEncounters[${index}].id is required`);
  }
  requireFinite(fixture.durationSeconds, `$.remainingEncounters[${index}].durationSeconds`, 0);
  requireFinite(fixture.enemyCount, `$.remainingEncounters[${index}].enemyCount`, 0);
  requireFinite(
    fixture.clusteredEnemyCount,
    `$.remainingEncounters[${index}].clusteredEnemyCount`,
    0,
  );
  requireFinite(fixture.incomingHitDamage, `$.remainingEncounters[${index}].incomingHitDamage`, 0);
  requireFinite(
    fixture.incomingHitsPerSecond,
    `$.remainingEncounters[${index}].incomingHitsPerSecond`,
    0,
  );
  requireFinite(fixture.lowHealthUptime, `$.remainingEncounters[${index}].lowHealthUptime`, 0);
  requireFinite(
    fixture.skillTriggerRatePerSecond,
    `$.remainingEncounters[${index}].skillTriggerRatePerSecond`,
    0,
  );
  if (
    !Number.isInteger(fixture.enemyCount) ||
    !Number.isInteger(fixture.clusteredEnemyCount) ||
    fixture.clusteredEnemyCount > fixture.enemyCount ||
    fixture.lowHealthUptime > 1
  ) {
    throw new EquipmentLoadoutEvaluationError(
      `$.remainingEncounters[${index}] has an invalid deterministic encounter shape`,
    );
  }
}

function validateInstanceSlots(instance: GeneratedEquipmentInstanceV1): string[] {
  const reasons: string[] = [];
  if (instance.frozen.slots.length === 0) {
    reasons.push('candidate has no equipment slots');
  }
  const seen = new Set<string>();
  for (const slot of instance.frozen.slots) {
    if (!isValidSlotId(slot)) reasons.push(`unknown slot ${slot}`);
    if (seen.has(slot)) reasons.push(`duplicate slot ${slot}`);
    seen.add(slot);
  }
  return reasons;
}

function canonicalInstances(
  instances: readonly GeneratedEquipmentInstanceV1[],
  path: string,
): GeneratedEquipmentInstanceV1[] {
  const byId = new Map<string, GeneratedEquipmentInstanceV1>();
  const occupied = new Map<string, string>();
  for (let index = 0; index < instances.length; index += 1) {
    const instance = validateGeneratedEquipmentInstanceV1(instances[index]);
    const slotReasons = validateInstanceSlots(instance);
    if (slotReasons.length > 0) {
      throw new EquipmentLoadoutEvaluationError(
        `${path}[${index}] is invalid: ${slotReasons.join(', ')}`,
      );
    }
    if (byId.has(instance.instanceId)) {
      throw new EquipmentLoadoutEvaluationError(
        `${path} contains duplicate instance ${instance.instanceId}`,
      );
    }
    byId.set(instance.instanceId, instance);
    for (const slot of instance.frozen.slots) {
      const prior = occupied.get(slot);
      if (prior !== undefined) {
        throw new EquipmentLoadoutEvaluationError(
          `${path} assigns slot ${slot} to both ${prior} and ${instance.instanceId}`,
        );
      }
      occupied.set(slot, instance.instanceId);
    }
  }
  return [...byId.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
}

function sourceKey(source: AbilityGrantSource): string {
  switch (source.kind) {
    case 'learned':
      return 'learned';
    case 'skill':
      return `skill:${source.skillId}`;
    case 'equipment':
      return `equipment:${source.instanceId}`;
    case 'generated-equipment':
      return `generated-equipment:${source.instanceId}:${source.effectOrdinal}`;
  }
}

function cloneSource(source: AbilityGrantSource): AbilityGrantSource {
  return { ...source };
}

function cloneSourceMap(
  source: ReadonlyMap<string, readonly AbilityGrantSource[]>,
): Map<string, AbilityGrantSource[]> {
  const result = new Map<string, AbilityGrantSource[]>();
  for (const [abilityId, sources] of [...source.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cloned = sources
      .map(cloneSource)
      .sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
    if (cloned.length > 0) result.set(abilityId, cloned);
  }
  return result;
}

function cloneOwnership(snapshot: EquipmentLoadoutSnapshot): MutableOwnership {
  return {
    active: cloneSourceMap(snapshot.activeAbilityGrantSources),
    passive: cloneSourceMap(snapshot.passiveAbilityGrantSources),
  };
}

function removeEquipmentSources(
  ownership: MutableOwnership,
  removed: readonly GeneratedEquipmentInstanceV1[],
): void {
  const removedIds = new Set(removed.map((instance) => instance.instanceId));
  for (const sourceMap of [ownership.active, ownership.passive]) {
    for (const [abilityId, sources] of sourceMap) {
      const retained = [...sources].filter(
        (source) => source.kind !== 'generated-equipment' || !removedIds.has(source.instanceId),
      );
      if (retained.length === 0) sourceMap.delete(abilityId);
      else
        sourceMap.set(
          abilityId,
          retained.sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))),
        );
    }
  }
}

function addGeneratedEquipmentSource(
  sourceMap: Map<string, AbilityGrantSource[]>,
  abilityId: string,
  instance: GeneratedEquipmentInstanceV1,
  effectOrdinal: number,
): void {
  const sources = sourceMap.get(abilityId) ?? [];
  const alreadyPresent = sources.some(
    (source) =>
      source.kind === 'generated-equipment' &&
      source.instanceId === instance.instanceId &&
      source.effectOrdinal === effectOrdinal,
  );
  if (alreadyPresent) return;
  sources.push({
    kind: 'generated-equipment',
    instanceId: instance.instanceId,
    effectOrdinal,
  });
  sources.sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
  sourceMap.set(abilityId, sources);
}

function addEquipmentSources(
  ownership: MutableOwnership,
  instance: GeneratedEquipmentInstanceV1,
): void {
  instance.frozen.abilityGrants.forEach((abilityId, effectOrdinal) => {
    addGeneratedEquipmentSource(ownership.active, abilityId, instance, effectOrdinal);
  });
  instance.frozen.passiveGrants.forEach((abilityId, effectOrdinal) => {
    addGeneratedEquipmentSource(ownership.passive, abilityId, instance, effectOrdinal);
  });
}

function configuredActives(
  currentConfiguration: readonly string[],
  ownership: MutableOwnership,
  candidate?: GeneratedEquipmentInstanceV1,
): { configured: string[]; blocked: string[] } {
  const available = ownership.active;
  const configured = currentConfiguration.filter(
    (abilityId, index) =>
      available.has(abilityId) && currentConfiguration.indexOf(abilityId) === index,
  );
  if (candidate !== undefined) {
    for (const abilityId of candidate.frozen.abilityGrants) {
      if (
        available.has(abilityId) &&
        !configured.includes(abilityId) &&
        configured.length < ACTIVE_ABILITY_SLOT_LIMIT
      ) {
        configured.push(abilityId);
      }
    }
  }
  const blocked =
    candidate?.frozen.abilityGrants
      .filter((abilityId) => available.has(abilityId) && !configured.includes(abilityId))
      .sort() ?? [];
  return { configured, blocked: [...new Set(blocked)] };
}

function activeWeapon(
  equipped: readonly GeneratedEquipmentInstanceV1[],
): ActiveWeaponSnapshotV1 | null {
  return (
    equipped.find((instance) => instance.frozen.activeWeaponSnapshot !== null)?.frozen
      .activeWeaponSnapshot ?? null
  );
}

function passivePrerequisiteMet(
  ability: AbilityDefinition,
  weapon: ActiveWeaponSnapshotV1 | null,
): boolean {
  if (ability.kind !== 'passive') return false;
  if (ability.weaponPrerequisite === undefined) return true;
  return (
    weapon !== null &&
    weaponSkillPrerequisiteMatches(
      ability.weaponPrerequisite,
      weapon.weaponClassSkillId,
      weapon.weaponTypeSkillId,
    )
  );
}

function passiveModifiers(
  ownership: MutableOwnership,
  weapon: ActiveWeaponSnapshotV1 | null,
): LegacyStatModifierLike[] {
  const modifiers: LegacyStatModifierLike[] = [];
  for (const abilityId of [...ownership.passive.keys()].sort()) {
    const ability = getAbilityDefinition(abilityId);
    if (ability === undefined || !passivePrerequisiteMet(ability, weapon)) continue;
    for (const effect of ability.effects) {
      if (effect.type === 'stat_add' || effect.type === 'stat_multiply') {
        modifiers.push({
          stat: effect.stat,
          op: effect.type === 'stat_add' ? 'add' : 'multiply',
          value: effect.value,
        });
      }
    }
  }
  return modifiers;
}

function equipmentSources(
  equipped: readonly GeneratedEquipmentInstanceV1[],
): Array<{ statBonuses: Readonly<Partial<Record<StatId, number>>>; weightLb: number }> {
  return equipped.map((instance) => ({
    statBonuses: instance.frozen.statBonuses,
    weightLb: instance.frozen.weightLb,
  }));
}

function effectiveStats(
  snapshot: EquipmentLoadoutSnapshot,
  equipped: readonly GeneratedEquipmentInstanceV1[],
  modifiers: readonly LegacyStatModifierLike[],
): Record<StatId, number> {
  return computeEffectiveStatsFromLoadout(
    snapshot.baseStats,
    snapshot.coreStatPoints,
    equipmentSources(equipped),
    modifiers,
  );
}

function weaponTargets(weapon: ActiveWeaponSnapshotV1, fixture: EquipmentEncounterFixture): number {
  if (fixture.enemyCount === 0) return 0;
  const chainTargets = 1 + weapon.pierce + weapon.bounceCount;
  const hasArea =
    weapon.aoeRadius > 0 ||
    weapon.trapExplosionRadius > 0 ||
    weapon.beamLength > 0 ||
    weapon.swingArcDeg > 90;
  return Math.min(
    fixture.enemyCount,
    Math.max(chainTargets, hasArea ? fixture.clusteredEnemyCount : 1),
  );
}

function expectedWeaponDps(
  weapon: ActiveWeaponSnapshotV1 | null,
  stats: Readonly<Record<StatId, number>>,
): number {
  if (weapon === null) return 0;
  const affinity = weapon.weaponType === WeaponType.MAGIC ? 'magic' : 'physical';
  const scaled = computePlayerScaledDamage(weapon.baseDamage, stats, {
    affinity,
    scaleWithPrimary: true,
  });
  const damage = computeExpectedCritDamage(scaled, stats.critChance, stats.critMultiplier);
  const accuracy = computeEffectiveAccuracyFromValues(
    weapon.weaponType,
    weapon.baseAccuracy,
    stats.accuracy,
  );
  const cooldownMs = applyAttackSpeedAndCooldownReduction(
    weapon.cooldownMs,
    stats.attackSpeed,
    stats.cooldownReduction,
  );
  return (damage * accuracy * 1_000) / cooldownMs;
}

function triggerUptime(ability: AbilityDefinition, fixture: EquipmentEncounterFixture): number {
  if (ability.kind === 'passive') return 0;
  switch (ability.trigger.kind) {
    case 'enemy_cluster':
      return fixture.clusteredEnemyCount >= ability.trigger.minEnemies ? 1 : 0;
    case 'low_health':
    case 'health_deficit_at_least':
      return fixture.lowHealthUptime;
    case 'low_health_crowded':
      return fixture.clusteredEnemyCount >= ability.trigger.minEnemies
        ? fixture.lowHealthUptime
        : 0;
    case 'skill_usage':
      return fixture.skillTriggerRatePerSecond > 0 ? 1 : 0;
  }
}

function expectedSpellDamage(baseDamage: number, stats: Readonly<Record<StatId, number>>): number {
  return computeExpectedCritDamage(
    computePlayerScaledDamage(baseDamage, stats, {
      affinity: 'magic',
      scaleWithPrimary: false,
    }),
    stats.critChance,
    stats.critMultiplier,
  );
}

function activeEffectValue(
  effect: CatalogEffect,
  stats: Readonly<Record<StatId, number>>,
  fixture: EquipmentEncounterFixture,
  weaponDps: number,
): number {
  const areaTargets = Math.max(1, fixture.clusteredEnemyCount);
  switch (effect.type) {
    case 'spell_fireball':
    case 'spell_frost_nova':
      return (
        expectedSpellDamage(
          resolveScalableOutputRounded(effect.damage, stats.intelligence),
          stats,
        ) * areaTargets
      );
    case 'spell_magic_missile':
      return expectedSpellDamage(
        resolveScalableOutputRounded(effect.damage, stats.intelligence),
        stats,
      );
    case 'spell_life_drain':
      return (
        expectedSpellDamage(
          resolveScalableOutputRounded(effect.damage, stats.intelligence),
          stats,
        ) + resolveScalableOutputRounded(effect.heal, stats.intelligence)
      );
    case 'spell_heal':
      return resolveScalableOutputRounded(effect.heal, stats.intelligence);
    case 'spell_pulse_shield':
      return resolveScalableOutput(effect.knockbackForce, stats.intelligence) * areaTargets;
    case 'spell_enemy_slow_burst':
      return (
        (1 - resolveScalableOutput(effect.slowMultiplier, stats.intelligence)) *
        resolveScalableOutput(effect.slowDurationMs, stats.intelligence) *
        areaTargets *
        0.001
      );
    case 'spell_timed_buff':
      return effect.modifiers.reduce(
        (sum, modifier) =>
          sum + Math.abs(resolveScalableOutput(modifier.value, stats.intelligence)),
        0,
      );
    case 'stat_add':
    case 'stat_multiply':
      return Math.abs(effect.value);
    case 'extra_projectile':
      return effect.count * weaponDps;
    case 'aura':
      return effect.dpsPercentOfDamage * areaTargets;
  }
}

function expectedActiveAbilityValue(
  configured: readonly string[],
  weapon: ActiveWeaponSnapshotV1 | null,
  stats: Readonly<Record<StatId, number>>,
  fixture: EquipmentEncounterFixture,
  config: EquipmentErvConfig,
): number {
  let value = 0;
  const weaponDps = expectedWeaponDps(weapon, stats);
  for (const abilityId of configured) {
    const ability = getAbilityDefinition(abilityId);
    if (ability === undefined || ability.kind === 'passive') continue;
    const uptime = triggerUptime(ability, fixture);
    if (uptime <= 0) continue;
    const cooldownFrames = applyCooldownReduction(ability.cooldownFrames, stats.cooldownReduction);
    const activations =
      cooldownFrames > 0
        ? (fixture.durationSeconds * config.framesPerSecond * uptime) / cooldownFrames
        : 0;
    value +=
      ability.effects.reduce(
        (sum, effect) => sum + activeEffectValue(effect, stats, fixture, weaponDps),
        0,
      ) * activations;
  }
  return value;
}

function scoreCoreComponents(
  weapon: ActiveWeaponSnapshotV1 | null,
  stats: Readonly<Record<StatId, number>>,
  equippedWeightLb: number,
  bodyWeightLb: number,
  fixtures: readonly EquipmentEncounterFixture[],
  config: EquipmentErvConfig,
): Record<EquipmentErvComponent, number> {
  const components = emptyComponents();
  const thresholds = computeEncumbranceThresholds(bodyWeightLb, stats.strength);
  const multiplier = computeEncumbranceMultiplier(
    computeEncumbranceBand(bodyWeightLb + equippedWeightLb, thresholds),
  );
  const weaponDps = expectedWeaponDps(weapon, stats);

  for (const fixture of fixtures) {
    const duration = fixture.durationSeconds;
    const targets = weapon === null ? 0 : weaponTargets(weapon, fixture);
    components.offense += weaponDps * duration * config.weights.offense;
    components.encounterFit +=
      weaponDps * Math.max(0, targets - 1) * duration * config.weights.encounterFit;

    const incomingHits = fixture.incomingHitsPerSecond * duration;
    const rawIncoming = fixture.incomingHitDamage * incomingHits;
    const taken =
      computeArmorReducedDamage(fixture.incomingHitDamage, stats.armor) *
      incomingHits *
      (1 - stats.dodgeChance);
    components.defense +=
      (stats.maxHp + stats.hpRegen * duration + Math.max(0, rawIncoming - taken)) *
      config.weights.defense;

    const unencumberedMobility = 1 + stats.moveSpeed;
    components.mobility += unencumberedMobility * duration * config.weights.mobility;
    components.encumbrance +=
      unencumberedMobility * (multiplier - 1) * duration * config.weights.encumbrance;
  }
  return components;
}

function passiveNonStatValue(
  ownership: MutableOwnership,
  weapon: ActiveWeaponSnapshotV1 | null,
  weaponDps: number,
  fixtures: readonly EquipmentEncounterFixture[],
): number {
  let value = 0;
  for (const abilityId of [...ownership.passive.keys()].sort()) {
    const ability = getAbilityDefinition(abilityId);
    if (ability === undefined || !passivePrerequisiteMet(ability, weapon)) continue;
    for (const effect of ability.effects) {
      if (effect.type === 'extra_projectile') {
        value += effect.count * weaponDps * fixtures.reduce((sum, f) => sum + f.durationSeconds, 0);
      } else if (effect.type === 'aura') {
        value += fixtures.reduce(
          (sum, fixture) =>
            sum +
            weaponDps *
              effect.dpsPercentOfDamage *
              fixture.durationSeconds *
              Math.max(1, fixture.clusteredEnemyCount),
          0,
        );
      }
    }
  }
  return value;
}

function affinityValue(
  equipped: readonly GeneratedEquipmentInstanceV1[],
  ownership: MutableOwnership,
  configured: readonly string[],
  tagWeights: Readonly<Record<string, number>>,
): number {
  const tags = new Set<string>();
  for (const instance of equipped) {
    for (const tag of instance.frozen.tags) tags.add(tag);
    const weapon = instance.frozen.activeWeaponSnapshot;
    if (weapon !== null) {
      tags.add('weapon');
      tags.add(weapon.weaponType === WeaponType.MAGIC ? 'magic' : 'physical');
      tags.add(weapon.aoeRadius > 0 || weapon.pierce > 0 ? 'aoe' : 'single-target');
      if (weapon.cooldownMs <= 500) tags.add('cadence');
    }
  }
  for (const abilityId of configured) {
    tags.add('active-ability');
    tags.add(`ability:${abilityId}`);
  }
  for (const abilityId of ownership.passive.keys()) {
    tags.add('passive-ability');
    tags.add(`ability:${abilityId}`);
  }
  return [...tags].sort().reduce((sum, tag) => sum + (tagWeights[tag] ?? 0), 0);
}

function scoreLoadout(
  snapshot: EquipmentLoadoutSnapshot,
  state: LoadoutScoringState,
  fixtures: readonly EquipmentEncounterFixture[],
  affinityTagWeights: Readonly<Record<string, number>>,
  config: EquipmentErvConfig,
): EquipmentLoadoutScore {
  const weapon = activeWeapon(state.equipped);
  const configured = configuredActives(state.equippedActiveAbilityIds, state.ownership).configured;
  const baseStats = effectiveStats(snapshot, state.equipped, []);
  const modifiers = passiveModifiers(state.ownership, weapon);
  const fullStats = effectiveStats(snapshot, state.equipped, modifiers);
  const equippedWeightLb = state.equipped.reduce(
    (sum, instance) => sum + instance.frozen.weightLb,
    0,
  );
  const baseComponents = scoreCoreComponents(
    weapon,
    baseStats,
    equippedWeightLb,
    snapshot.bodyWeightLb,
    fixtures,
    config,
  );
  const fullComponents = scoreCoreComponents(
    weapon,
    fullStats,
    equippedWeightLb,
    snapshot.bodyWeightLb,
    fixtures,
    config,
  );
  const components = { ...baseComponents };
  components.passiveAbility =
    (COMPONENTS.filter(
      (component) =>
        component !== 'passiveAbility' &&
        component !== 'activeAbility' &&
        component !== 'affinity' &&
        component !== 'purchaseCost',
    ).reduce((sum, component) => sum + fullComponents[component] - baseComponents[component], 0) +
      passiveNonStatValue(
        state.ownership,
        weapon,
        expectedWeaponDps(weapon, fullStats),
        fixtures,
      )) *
    config.weights.passiveAbility;
  components.activeAbility =
    fixtures.reduce(
      (sum, fixture) =>
        sum + expectedActiveAbilityValue(configured, weapon, fullStats, fixture, config),
      0,
    ) * config.weights.activeAbility;
  components.affinity =
    affinityValue(state.equipped, state.ownership, configured, affinityTagWeights) *
    config.weights.affinity;

  return {
    total: sumComponents(components),
    components,
    effectiveStats: fullStats,
    equippedActiveAbilityIds: configured,
    availablePassiveAbilityIds: [...state.ownership.passive.keys()].sort(),
    activeWeaponInstanceId: weapon?.generatedEquipmentInstanceId ?? null,
  };
}

function subtractComponents(
  next: EquipmentErvComponents,
  current: EquipmentErvComponents,
  purchaseCost: number,
): EquipmentErvComponents {
  const result = emptyComponents();
  for (const component of COMPONENTS) {
    result[component] = next[component] - current[component];
  }
  result.purchaseCost = purchaseCost;
  return result;
}

export function evaluateEquipmentLoadoutCandidates(
  input: EvaluateEquipmentLoadoutInput,
): EquipmentLoadoutEvaluationResult {
  const config = input.config ?? DEFAULT_EQUIPMENT_ERV_CONFIG;
  validateConfig(config);
  requireFinite(input.current.bodyWeightLb, '$.current.bodyWeightLb', 0);
  input.remainingEncounters.forEach(validateEncounter);
  for (const [tag, weight] of Object.entries(input.affinityTagWeights)) {
    requireFinite(weight, `$.affinityTagWeights.${tag}`);
  }

  const currentEquipped = canonicalInstances(input.current.equipped, '$.current.equipped');
  const currentOwnership = cloneOwnership(input.current);
  const currentConfiguration = configuredActives(
    input.current.equippedActiveAbilityIds,
    currentOwnership,
  ).configured;
  const currentState: LoadoutScoringState = {
    equipped: currentEquipped,
    ownership: currentOwnership,
    equippedActiveAbilityIds: currentConfiguration,
  };
  const currentScore = scoreLoadout(
    input.current,
    currentState,
    input.remainingEncounters,
    input.affinityTagWeights,
    config,
  );

  const ranked: EquipmentLoadoutEvaluation[] = [];
  const rejected: RejectedEquipmentLoadoutCandidate[] = [];
  const candidateIds = new Set<string>();

  for (const rawCandidate of input.candidates) {
    const reasons: string[] = [];
    let candidateInstance: GeneratedEquipmentInstanceV1;
    try {
      candidateInstance = validateGeneratedEquipmentInstanceV1(rawCandidate.instance);
      reasons.push(...validateInstanceSlots(candidateInstance));
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
      candidateInstance = rawCandidate.instance;
    }
    if (!Number.isFinite(rawCandidate.purchaseCost) || rawCandidate.purchaseCost < 0) {
      reasons.push('purchaseCost must be a finite non-negative number');
    }
    if (candidateIds.has(candidateInstance.instanceId)) {
      reasons.push(`duplicate candidate ${candidateInstance.instanceId}`);
    }
    candidateIds.add(candidateInstance.instanceId);
    if (reasons.length > 0) {
      rejected.push({ candidate: rawCandidate, reasons: [...new Set(reasons)].sort() });
      continue;
    }

    const candidateSlots = new Set(candidateInstance.frozen.slots);
    const displaced = currentEquipped.filter((instance) =>
      instance.frozen.slots.some((slot) => candidateSlots.has(slot)),
    );
    const retained = currentEquipped.filter(
      (instance) => !displaced.some((removed) => removed.instanceId === instance.instanceId),
    );
    const nextEquipped = canonicalInstances(
      [...retained, candidateInstance],
      `$.candidates.${candidateInstance.instanceId}.next`,
    );

    const retainedOwnership = cloneOwnership(input.current);
    removeEquipmentSources(retainedOwnership, displaced);
    const retainedConfigured = configuredActives(
      currentConfiguration,
      retainedOwnership,
    ).configured;
    const retainedState: LoadoutScoringState = {
      equipped: retained,
      ownership: retainedOwnership,
      equippedActiveAbilityIds: retainedConfigured,
    };
    const retainedScore = scoreLoadout(
      input.current,
      retainedState,
      input.remainingEncounters,
      input.affinityTagWeights,
      config,
    );

    const nextOwnership = cloneOwnership(input.current);
    removeEquipmentSources(nextOwnership, displaced);
    addEquipmentSources(nextOwnership, candidateInstance);
    const nextConfiguration = configuredActives(
      retainedConfigured,
      nextOwnership,
      candidateInstance,
    );
    const nextState: LoadoutScoringState = {
      equipped: nextEquipped,
      ownership: nextOwnership,
      equippedActiveAbilityIds: nextConfiguration.configured,
    };
    const nextScore = scoreLoadout(
      input.current,
      nextState,
      input.remainingEncounters,
      input.affinityTagWeights,
      config,
    );
    const purchaseCostComponent = -rawCandidate.purchaseCost * config.weights.purchaseCost;
    const components = subtractComponents(
      nextScore.components,
      currentScore.components,
      purchaseCostComponent,
    );
    const candidateContribution = nextScore.total - retainedScore.total;
    const displacementCost = currentScore.total - retainedScore.total;
    const score = sumComponents(components);

    ranked.push({
      candidate: { ...rawCandidate, instance: candidateInstance },
      score,
      currentScore,
      nextScore,
      components,
      candidateContribution,
      displacementCost,
      displacedInstanceIds: displaced.map((instance) => instance.instanceId).sort(),
      configuredActiveAbilityIds: nextConfiguration.configured,
      blockedActiveAbilityIds: nextConfiguration.blocked,
    });
  }

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.candidate.instance.fingerprint.localeCompare(b.candidate.instance.fingerprint) ||
      a.candidate.instance.instanceId.localeCompare(b.candidate.instance.instanceId),
  );
  rejected.sort((a, b) =>
    a.candidate.instance.instanceId.localeCompare(b.candidate.instance.instanceId),
  );
  return { ranked, rejected };
}
