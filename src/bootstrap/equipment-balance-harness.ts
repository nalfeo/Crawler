import type { GameWorld } from '../core/world.js';
import { createGameWorld } from '../core/world.js';
import { spawnEnemy, spawnPlayer } from '../core/helpers.js';
import {
  equip,
  getEffectiveStats,
  getEquipmentState,
  initializeBaseStats,
} from '../core/systems/equipmentSystem.js';
import { computeEquippedWeightLb } from '../core/effective-stats.js';
import { getEntityEncumbranceSnapshot } from '../core/encumbrance.js';
import { requireGeneratedEquipmentActiveWeaponSnapshot } from '../core/generated-equipment-registry.js';
import { setActiveWeapon } from '../game/weaponSystem.js';
import { generateEquipmentInstance } from '../game/generated-equipment-generator.js';
import { grantEquipmentAbilitySources } from '../game/equipment-ability-grants.js';
import { runSimulationStep } from '../game/ai/simulation-step.js';
import { getOrCreateAbilityState } from '../game/systems/abilitySystem.js';
import { spendPoints } from '../game/systems/statsSystem.js';
import type {
  GeneratedEquipmentEnhancementLevel,
  GeneratedEquipmentInstanceV1,
  GeneratedEquipmentRarity,
} from '../shared/generated-equipment-types.js';
import type { EquipmentItemDef } from '../shared/equipment-types.js';
import type { PrimaryStatId } from '../shared/stats.js';
import type { EncumbranceBand } from '../shared/encumbrance.js';
import { createInputState, type InputState } from '../shared/input.js';
import { GAME } from '../shared/constants.js';
import { getEquipmentDefForItem } from '../shared/equipmentDefs.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { createFloorMainSceneOptions } from './floor-main-scene-options.js';

export const EQUIPMENT_BALANCE_LEVELS = [1, 6, 11] as const;
export type EquipmentBalanceLevel = (typeof EQUIPMENT_BALANCE_LEVELS)[number];

export const EQUIPMENT_DPS_RATIO_MIN = 1.7;
export const EQUIPMENT_DPS_RATIO_MAX = 2.3;
const MEASUREMENT_FRAMES = 600;
const WARMUP_FRAMES = 2;
const TARGET_HP = 1_000_000;

type EquipmentBalanceBuildId =
  | 'single-target'
  | 'aoe'
  | 'cadence-crit'
  | 'active-ability'
  | 'defensive-encumbrance';

interface GearSpec {
  readonly baseId: string;
  readonly rarity?: GeneratedEquipmentRarity;
}

interface BuildStage {
  readonly coreStats: Partial<Readonly<Record<PrimaryStatId, number>>>;
  readonly gear: readonly GearSpec[];
}

interface TargetOffset {
  readonly x: number;
  readonly y: number;
}

interface EncounterShape {
  readonly playerStartX: number;
  readonly stopX: number;
  readonly targets: readonly TargetOffset[];
}

interface EquipmentBalanceBuild {
  readonly id: EquipmentBalanceBuildId;
  readonly label: string;
  readonly focus: string;
  readonly seedBase: number;
  readonly weaponBaseId: string;
  readonly encounter: EncounterShape;
  readonly stages: Readonly<Record<EquipmentBalanceLevel, BuildStage>>;
}

const COMMON_STAGE = {
  coreStats: {},
  gear: [],
} as const satisfies BuildStage;

export const EQUIPMENT_BALANCE_BUILD_IDS: readonly EquipmentBalanceBuildId[] = [
  'single-target',
  'aoe',
  'cadence-crit',
  'active-ability',
  'defensive-encumbrance',
];

const BUILDS: Readonly<Record<EquipmentBalanceBuildId, EquipmentBalanceBuild>> = {
  'single-target': {
    id: 'single-target',
    label: 'Single-target pistol',
    focus: 'single-target',
    seedBase: 1100,
    weaponBaseId: 'plasma-pistol',
    encounter: {
      playerStartX: 0,
      stopX: 0,
      targets: [{ x: 6, y: 0 }],
    },
    stages: {
      1: COMMON_STAGE,
      6: {
        coreStats: { strength: 3, dexterity: 2 },
        gear: [{ baseId: 'iron-armguard' }],
      },
      11: {
        coreStats: { strength: 6, dexterity: 4 },
        gear: [{ baseId: 'iron-armguard' }, { baseId: 'steel-pauldrons' }],
      },
    },
  },
  aoe: {
    id: 'aoe',
    label: 'Clustered fireball',
    focus: 'aoe',
    seedBase: 2200,
    weaponBaseId: 'fireball',
    encounter: {
      playerStartX: 0,
      stopX: 0,
      targets: [
        { x: 4, y: 0 },
        { x: 4, y: 1 },
        { x: 4, y: -1 },
        { x: 5, y: 0.75 },
        { x: 5, y: -0.75 },
      ],
    },
    stages: {
      1: COMMON_STAGE,
      6: {
        coreStats: { intelligence: 3, wisdom: 2 },
        gear: [{ baseId: 'signet-of-focus' }],
      },
      11: {
        coreStats: { intelligence: 6, wisdom: 4 },
        gear: [{ baseId: 'signet-of-focus' }, { baseId: 'band-of-fortune' }],
      },
    },
  },
  'cadence-crit': {
    id: 'cadence-crit',
    label: 'Cadence and crit throwing knife',
    focus: 'cadence/crit',
    seedBase: 3300,
    weaponBaseId: 'throwing-knife',
    encounter: {
      playerStartX: 0,
      stopX: 0,
      targets: [{ x: 5, y: 0 }],
    },
    stages: {
      1: COMMON_STAGE,
      6: {
        coreStats: { dexterity: 3, luck: 2 },
        gear: [{ baseId: 'beaded-bracelet' }],
      },
      11: {
        coreStats: { dexterity: 6, luck: 4 },
        gear: [{ baseId: 'beaded-bracelet' }, { baseId: 'band-of-fortune' }],
      },
    },
  },
  'active-ability': {
    id: 'active-ability',
    label: 'Sword with equipment-granted fireball',
    focus: 'active ability',
    seedBase: 4400,
    weaponBaseId: 'iron-sword',
    encounter: {
      playerStartX: 0,
      stopX: 0,
      targets: [
        { x: 1.25, y: 0 },
        { x: 2, y: 0.75 },
        { x: 2, y: -0.75 },
      ],
    },
    stages: {
      1: COMMON_STAGE,
      6: {
        coreStats: { strength: 2, intelligence: 2, wisdom: 1 },
        gear: [
          { baseId: 'band-of-fortune', rarity: 'rare' },
          { baseId: 'signet-of-focus', rarity: 'rare' },
          { baseId: 'beaded-bracelet', rarity: 'rare' },
        ],
      },
      11: {
        coreStats: { strength: 4, intelligence: 4, wisdom: 2 },
        gear: [
          { baseId: 'band-of-fortune', rarity: 'rare' },
          { baseId: 'signet-of-focus', rarity: 'rare' },
          { baseId: 'beaded-bracelet', rarity: 'rare' },
        ],
      },
    },
  },
  'defensive-encumbrance': {
    id: 'defensive-encumbrance',
    label: 'Armored bat approach',
    focus: 'defense/encumbrance',
    seedBase: 5500,
    weaponBaseId: 'bone-club',
    encounter: {
      playerStartX: -18,
      stopX: -1.5,
      targets: [
        { x: 0, y: 0 },
        { x: 0.75, y: 0.75 },
      ],
    },
    stages: {
      1: {
        coreStats: {},
        gear: [{ baseId: 'iron-helm' }],
      },
      6: {
        coreStats: { constitution: 5 },
        gear: [{ baseId: 'iron-breastplate' }, { baseId: 'iron-greaves' }],
      },
      11: {
        coreStats: { constitution: 10 },
        gear: [
          { baseId: 'iron-helm' },
          { baseId: 'iron-breastplate' },
          { baseId: 'travelers-cloak' },
          { baseId: 'iron-greaves' },
          { baseId: 'leather-boots' },
          { baseId: 'leather-gloves' },
          { baseId: 'band-of-fortune' },
          { baseId: 'signet-of-focus' },
        ],
      },
    },
  },
};

export interface EquipmentBalanceWorldFactory {
  (seed: number, runKey: string): GameWorld;
}

export interface EquipmentBalanceMeasurement {
  readonly buildId: EquipmentBalanceBuildId;
  readonly buildLabel: string;
  readonly focus: string;
  readonly level: EquipmentBalanceLevel;
  readonly seed: number;
  readonly aggregateDps: number;
  readonly weaponAndPassiveDps: number;
  readonly activeAbilityDps: number;
  readonly totalDamage: number;
  readonly hitCount: number;
  readonly critCount: number;
  readonly targetCount: number;
  readonly equipmentConfigs: readonly string[];
  readonly effectIds: readonly string[];
  readonly activeAbilityIds: readonly string[];
  readonly passiveAbilityIds: readonly string[];
  readonly baseDamage: number;
  readonly attackSpeed: number;
  readonly critChance: number;
  readonly damageBonus: number;
  readonly damagePercent: number;
  readonly strength: number;
  readonly armor: number;
  readonly equippedWeightLb: number;
  readonly encumbranceBand: EncumbranceBand;
}

export interface EquipmentBalanceBuildResult {
  readonly buildId: EquipmentBalanceBuildId;
  readonly label: string;
  readonly focus: string;
  readonly levels: Readonly<Record<EquipmentBalanceLevel, EquipmentBalanceMeasurement>>;
  readonly ratioLevel1To6: number;
  readonly ratioLevel6To11: number;
}

export interface EquipmentBalanceCohortReport {
  readonly measurementFrames: number;
  readonly builds: readonly EquipmentBalanceBuildResult[];
  readonly medianLevel1To6: number;
  readonly medianLevel6To11: number;
  readonly passes: boolean;
}

interface EncounterRun {
  readonly damage: number;
  readonly dps: number;
  readonly abilityDps: number;
  readonly hitCount: number;
  readonly critCount: number;
  readonly instances: readonly GeneratedEquipmentInstanceV1[];
  readonly activeAbilityIds: readonly string[];
  readonly passiveAbilityIds: readonly string[];
  readonly baseDamage: number;
  readonly attackSpeed: number;
  readonly critChance: number;
  readonly damageBonus: number;
  readonly damagePercent: number;
  readonly strength: number;
  readonly armor: number;
  readonly equippedWeightLb: number;
  readonly encumbranceBand: EncumbranceBand;
}

function defaultWorldFactory(seed: number, runKey: string): GameWorld {
  return createGameWorld({
    seed,
    floor: 1,
    entityCapacityMode: 'test',
    generatedEquipmentRunKey: runKey,
  });
}

function stageRarity(level: EquipmentBalanceLevel): GeneratedEquipmentRarity {
  if (level === 1) return 'common';
  if (level === 6) return 'uncommon';
  return 'rare';
}

function stageEnhancement(level: EquipmentBalanceLevel): GeneratedEquipmentEnhancementLevel {
  if (level === 1) return 0;
  if (level === 6) return 2;
  return 5;
}

function canEnhance(baseId: string): boolean {
  const def = getEquipmentDefForItem(baseId);
  return def?.weaponId !== undefined || (def?.statBonuses.armor ?? 0) > 0;
}

function requestFor(
  baseId: string,
  level: EquipmentBalanceLevel,
  rarity = stageRarity(level),
): Parameters<typeof generateEquipmentInstance>[1] {
  return {
    baseId,
    itemLevel: level,
    rarity,
    enhancementLevel: canEnhance(baseId) ? stageEnhancement(level) : 0,
  };
}

function equipGenerated(
  world: GameWorld,
  player: number,
  instance: GeneratedEquipmentInstanceV1,
): void {
  const def: EquipmentItemDef = {
    id: instance.instanceId,
    name: instance.frozen.displayName,
    slots: instance.frozen.slots,
    statBonuses: instance.frozen.statBonuses,
    rarity: instance.rarity,
    tags: instance.frozen.tags,
    weightLb: instance.frozen.weightLb,
  };
  const result = equip(world, player, def, { force: true });
  if (!result.ok) {
    throw new Error(
      `Balance fixture could not equip ${instance.instanceId}: ${result.reasons
        .map((reason) => ('message' in reason ? reason.message : reason.type))
        .join(', ')}`,
    );
  }
  grantEquipmentAbilitySources(world, player, instance.instanceId);
}

function configureCoreStats(
  world: GameWorld,
  level: EquipmentBalanceLevel,
  points: Partial<Readonly<Record<PrimaryStatId, number>>>,
): void {
  // Advance playerLevel so canonical hooks see the correct cohort level.
  world.playerLevel.level = level;
  // Grant the full production budget for this level (level × pointsPerLevel).
  world.playerLevel.unspentPoints = level * world.playerLevel.pointsPerLevel;
  // Allocate authored points through the production spending seam.
  if (Object.keys(points).length > 0) {
    spendPoints(world, points);
  }
}

function step(
  world: GameWorld,
  input: InputState,
  hooks: ReturnType<typeof createFloorMainSceneOptions>,
): void {
  runSimulationStep(world, input, GAME.DELTA_MS, {
    preSystems: hooks.preSystems,
    postSystems: hooks.postSystems,
  });
}

function runEncounter(
  build: EquipmentBalanceBuild,
  level: EquipmentBalanceLevel,
  worldFactory: EquipmentBalanceWorldFactory,
): EncounterRun {
  const seed = build.seedBase + level * 17;
  const runKey = `balance-${build.id}-${level}`;
  const world = worldFactory(seed, runKey);
  world.state = 'playing';
  const player = spawnPlayer(world, build.encounter.playerStartX, 0);
  world.featureUnlocks.spells = true;
  initializeBaseStats(world, player, { maxHp: TARGET_HP });
  world.stores.health.current[player] = TARGET_HP;
  world.stores.health.max[player] = TARGET_HP;
  configureCoreStats(world, level, build.stages[level].coreStats);

  const weapon = generateEquipmentInstance(world, requestFor(build.weaponBaseId, level));
  const gear = build.stages[level].gear.map((spec) =>
    generateEquipmentInstance(world, requestFor(spec.baseId, level, spec.rarity)),
  );
  const instances = [weapon, ...gear];
  for (const instance of instances) equipGenerated(world, player, instance);
  setActiveWeapon(world, requireGeneratedEquipmentActiveWeaponSnapshot(world, weapon.instanceId));

  const abilityState = getOrCreateAbilityState(world, player);
  const configuredActiveAbilityIds = [...abilityState.equippedActiveAbilityIds];

  const hooks = createFloorMainSceneOptions('floor1');
  const warmupInput = createInputState();
  for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) {
    step(world, warmupInput, hooks);
  }

  const targetIds = build.encounter.targets.map((offset) =>
    spawnEnemy(world, offset.x, offset.y, TARGET_HP),
  );
  const targetSet = new Set(targetIds);
  const startingHealth = TARGET_HP * targetIds.length;
  let hitCount = 0;
  let critCount = 0;
  let abilityDamage = 0;
  const input = createInputState();

  for (let frame = 0; frame < MEASUREMENT_FRAMES; frame += 1) {
    const playerX = world.stores.position.x[player] ?? 0;
    input.moveX = playerX < build.encounter.stopX ? 1 : 0;
    step(world, input, hooks);
    for (const event of world.combatEvents) {
      if (
        event.type !== 'hit' ||
        event.targetEid === undefined ||
        !targetSet.has(event.targetEid)
      ) {
        continue;
      }
      hitCount += 1;
      if (event.isCrit === true) critCount += 1;
      if (event.fromActiveAbility === true) abilityDamage += event.amount;
    }
    world.combatEvents.length = 0;
    world.vfxEvents.length = 0;
  }

  const remainingHealth = targetIds.reduce(
    (sum, target) => sum + (world.stores.health.current[target] ?? 0),
    0,
  );
  const damage = startingHealth - remainingHealth;
  const seconds = (MEASUREMENT_FRAMES * GAME.DELTA_MS) / 1_000;
  const stats = getEffectiveStats(world, player);
  const equipmentState = getEquipmentState(world, player);
  const equippedWeightLb = computeEquippedWeightLb(world, equipmentState);
  const encumbranceBand = getEntityEncumbranceSnapshot(world, player).band;

  return {
    damage,
    dps: damage / seconds,
    abilityDps: abilityDamage / seconds,
    hitCount,
    critCount,
    instances,
    activeAbilityIds: configuredActiveAbilityIds,
    passiveAbilityIds: [...abilityState.passiveAbilityIds],
    baseDamage: weapon.frozen.activeWeaponSnapshot?.baseDamage ?? 0,
    attackSpeed: stats.attackSpeed,
    critChance: stats.critChance,
    damageBonus: stats.damageBonus,
    damagePercent: stats.damagePercent,
    strength: stats.strength,
    armor: stats.armor,
    equippedWeightLb,
    encumbranceBand,
  };
}

function measurement(
  build: EquipmentBalanceBuild,
  level: EquipmentBalanceLevel,
  worldFactory: EquipmentBalanceWorldFactory,
): EquipmentBalanceMeasurement {
  const run = runEncounter(build, level, worldFactory);
  return {
    buildId: build.id,
    buildLabel: build.label,
    focus: build.focus,
    level,
    seed: build.seedBase + level * 17,
    aggregateDps: run.dps,
    weaponAndPassiveDps: Math.max(0, run.dps - run.abilityDps),
    activeAbilityDps: run.abilityDps,
    totalDamage: run.damage,
    hitCount: run.hitCount,
    critCount: run.critCount,
    targetCount: build.encounter.targets.length,
    equipmentConfigs: run.instances.map(
      (instance) =>
        `${instance.baseId}@L${instance.itemLevel}/${instance.rarity}/+${instance.enhancementLevel}`,
    ),
    effectIds: run.instances.flatMap((instance) =>
      instance.resolvedEffects.map((effect) => effect.effectId),
    ),
    activeAbilityIds: run.activeAbilityIds,
    passiveAbilityIds: run.passiveAbilityIds,
    baseDamage: run.baseDamage,
    attackSpeed: run.attackSpeed,
    critChance: run.critChance,
    damageBonus: run.damageBonus,
    damagePercent: run.damagePercent,
    strength: run.strength,
    armor: run.armor,
    equippedWeightLb: run.equippedWeightLb,
    encumbranceBand: run.encumbranceBand,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function inBand(value: number): boolean {
  return value >= EQUIPMENT_DPS_RATIO_MIN && value <= EQUIPMENT_DPS_RATIO_MAX;
}

export function runEquipmentBalanceCohort(
  buildOrder: readonly EquipmentBalanceBuildId[] = EQUIPMENT_BALANCE_BUILD_IDS,
  worldFactory: EquipmentBalanceWorldFactory = defaultWorldFactory,
): EquipmentBalanceCohortReport {
  const builds = buildOrder.map((buildId): EquipmentBalanceBuildResult => {
    const build = BUILDS[buildId];
    const level1 = measurement(build, 1, worldFactory);
    const level6 = measurement(build, 6, worldFactory);
    const level11 = measurement(build, 11, worldFactory);
    return {
      buildId,
      label: build.label,
      focus: build.focus,
      levels: { 1: level1, 6: level6, 11: level11 },
      ratioLevel1To6: level6.aggregateDps / level1.aggregateDps,
      ratioLevel6To11: level11.aggregateDps / level6.aggregateDps,
    };
  });
  const medianLevel1To6 = median(builds.map((build) => build.ratioLevel1To6));
  const medianLevel6To11 = median(builds.map((build) => build.ratioLevel6To11));
  return {
    measurementFrames: MEASUREMENT_FRAMES,
    builds,
    medianLevel1To6,
    medianLevel6To11,
    passes: inBand(medianLevel1To6) && inBand(medianLevel6To11),
  };
}

export interface GeneratedEquipmentDistributionSample {
  readonly key: string;
  readonly seed: number;
  readonly baseId: string;
  readonly rarity: GeneratedEquipmentRarity;
  readonly enhancementLevel: GeneratedEquipmentEnhancementLevel;
  readonly effectUnits: number;
  readonly effectIds: readonly string[];
  readonly effectKinds: readonly string[];
  readonly inherentValue: number;
  readonly fingerprint: string;
}

export interface GeneratedEquipmentDistributionReport {
  readonly sampleCount: number;
  readonly rarityCounts: Readonly<Record<GeneratedEquipmentRarity, number>>;
  readonly effectCounts: Readonly<Record<string, number>>;
  readonly effectKindCounts: Readonly<Record<string, number>>;
  readonly enhancementCounts: Readonly<Record<number, number>>;
  readonly samples: readonly GeneratedEquipmentDistributionSample[];
  readonly replayKey: string;
}

const DISTRIBUTION_SEEDS = [2101, 2102, 2103, 2104, 2105, 2106] as const;
const DISTRIBUTION_BASE_IDS = ['plasma-pistol', 'iron-breastplate', 'band-of-fortune'] as const;
const DISTRIBUTION_RARITIES = ['common', 'uncommon', 'rare'] as const;

interface DistributionConfig {
  readonly seed: number;
  readonly baseId: string;
  readonly rarity: GeneratedEquipmentRarity;
  readonly enhancementLevel: GeneratedEquipmentEnhancementLevel;
}

function distributionConfigs(): DistributionConfig[] {
  const configs: DistributionConfig[] = [];
  for (let seedIndex = 0; seedIndex < DISTRIBUTION_SEEDS.length; seedIndex += 1) {
    const seed = DISTRIBUTION_SEEDS[seedIndex]!;
    for (const baseId of DISTRIBUTION_BASE_IDS) {
      for (const rarity of DISTRIBUTION_RARITIES) {
        configs.push({
          seed,
          baseId,
          rarity,
          enhancementLevel: canEnhance(baseId)
            ? (seedIndex as GeneratedEquipmentEnhancementLevel)
            : 0,
        });
      }
    }
  }
  return configs;
}

export function runGeneratedEquipmentDistributionFixtures(
  order: 'forward' | 'reverse' = 'forward',
  worldFactory: EquipmentBalanceWorldFactory = defaultWorldFactory,
): GeneratedEquipmentDistributionReport {
  const configs = distributionConfigs();
  if (order === 'reverse') configs.reverse();
  const samples = configs.map((config): GeneratedEquipmentDistributionSample => {
    const key = `${config.seed}:${config.baseId}:${config.rarity}:${config.enhancementLevel}`;
    const world = worldFactory(config.seed, `distribution-${key.replaceAll(':', '-')}`);
    const instance = generateEquipmentInstance(world, {
      baseId: config.baseId,
      itemLevel: 6,
      rarity: config.rarity,
      enhancementLevel: config.enhancementLevel,
    });
    return {
      key,
      seed: config.seed,
      baseId: config.baseId,
      rarity: config.rarity,
      enhancementLevel: config.enhancementLevel,
      effectUnits: instance.resolvedEffects.reduce(
        (sum, effect) => sum + ('unitCost' in effect ? effect.unitCost : 0),
        0,
      ),
      effectIds: instance.resolvedEffects.map((effect) => effect.effectId),
      effectKinds: instance.resolvedEffects.map((effect) =>
        'kind' in effect ? effect.kind : 'legacy',
      ),
      inherentValue:
        instance.frozen.activeWeaponSnapshot?.baseDamage ?? instance.frozen.statBonuses.armor ?? 0,
      fingerprint: instance.fingerprint,
    };
  });
  const canonicalSamples = [...samples].sort((left, right) => left.key.localeCompare(right.key));
  const rarityCounts = { common: 0, uncommon: 0, rare: 0 };
  const effectCounts: Record<string, number> = {};
  const effectKindCounts: Record<string, number> = {};
  const enhancementCounts: Record<number, number> = {};
  for (const sample of canonicalSamples) {
    rarityCounts[sample.rarity] += 1;
    enhancementCounts[sample.enhancementLevel] =
      (enhancementCounts[sample.enhancementLevel] ?? 0) + 1;
    for (const effectId of sample.effectIds) {
      effectCounts[effectId] = (effectCounts[effectId] ?? 0) + 1;
    }
    for (const effectKind of sample.effectKinds) {
      effectKindCounts[effectKind] = (effectKindCounts[effectKind] ?? 0) + 1;
    }
  }
  return {
    sampleCount: canonicalSamples.length,
    rarityCounts,
    effectCounts,
    effectKindCounts,
    enhancementCounts,
    samples: canonicalSamples,
    replayKey: canonicalJson(canonicalSamples),
  };
}

function number(value: number): string {
  return value.toFixed(3);
}

export function formatEquipmentBalanceReport(report: EquipmentBalanceCohortReport): string {
  const lines = [
    `Equipment balance gate: ${report.passes ? 'PASS' : 'FAIL'}`,
    `Band 1->6 median=${number(report.medianLevel1To6)} required=[${EQUIPMENT_DPS_RATIO_MIN}, ${EQUIPMENT_DPS_RATIO_MAX}]`,
    `Band 6->11 median=${number(report.medianLevel6To11)} required=[${EQUIPMENT_DPS_RATIO_MIN}, ${EQUIPMENT_DPS_RATIO_MAX}]`,
  ];
  for (const build of report.builds) {
    lines.push(
      `${build.buildId} (${build.focus}) ratios 1->6=${number(build.ratioLevel1To6)} 6->11=${number(build.ratioLevel6To11)}`,
    );
    for (const level of EQUIPMENT_BALANCE_LEVELS) {
      const result = build.levels[level];
      lines.push(
        `  L${level} seed=${result.seed} aggregate=${number(result.aggregateDps)} weapon/passive=${number(result.weaponAndPassiveDps)} active=${number(result.activeAbilityDps)} damage=${number(result.totalDamage)} hits=${result.hitCount} crits=${result.critCount} targets=${result.targetCount} config=[${result.equipmentConfigs.join(',')}] baseDamage=${number(result.baseDamage)} attackSpeed=${number(result.attackSpeed)} critChance=${number(result.critChance)} damageBonus=${number(result.damageBonus)} damagePercent=${number(result.damagePercent)} strength=${number(result.strength)} armor=${number(result.armor)} weightLb=${number(result.equippedWeightLb)} encumbrance=${result.encumbranceBand} effects=[${result.effectIds.join(',')}] active=[${result.activeAbilityIds.join(',')}] passive=[${result.passiveAbilityIds.join(',')}]`,
      );
    }
  }
  return lines.join('\n');
}

export function formatGeneratedEquipmentDistributionReport(
  report: GeneratedEquipmentDistributionReport,
): string {
  return [
    `Distribution fixtures: ${report.sampleCount}`,
    `Rarity counts: ${canonicalJson(report.rarityCounts)}`,
    `Enhancement counts: ${canonicalJson(report.enhancementCounts)}`,
    `Effect counts: ${canonicalJson(report.effectCounts)}`,
    `Effect-kind counts: ${canonicalJson(report.effectKindCounts)}`,
  ].join('\n');
}
