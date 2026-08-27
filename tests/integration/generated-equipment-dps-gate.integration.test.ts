import { setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  createActiveWeaponSnapshotV1,
  createGeneratedEquipmentInstance,
  generatedEquipmentInstanceKey,
  listGeneratedEquipmentInstances,
  requireGeneratedEquipmentActiveWeaponSnapshot,
} from '../../src/core/generated-equipment-registry.js';
import {
  Health,
  type GameWorld,
  spawnEnemy,
  spawnPlayer,
  statSystem,
} from '../../src/core/index.js';
import {
  addGeneratedEquipmentToBag,
  equipFromBag,
} from '../../src/core/systems/equipmentSystem.js';
import { runSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { abilitySystem, equipActiveAbility } from '../../src/game/systems/abilitySystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { applyStartPlayerLevel } from '../../src/game/scenarios/playerLevelProgression.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  type GeneratedEquipmentCreateInputV1,
  type GeneratedEquipmentRarity,
} from '../../src/shared/generated-equipment-types.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { statusEffectSystem } from '../../src/core/systems/statusEffectSystem.js';
import { hashStringToSeed } from '../../src/shared/random.js';
import { makeOpenFloorMap } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';

type LevelBand = 1 | 6 | 11;

interface BuildArchetype {
  readonly id: string;
  readonly role: string;
  readonly weaponId: string;
  readonly baseDamage: number;
  readonly cooldownMs: number;
  readonly aoeRadius?: number;
  readonly statBonuses?: Partial<
    Record<'critChance' | 'armor' | 'moveSpeed' | 'intelligence', number>
  >;
  readonly abilityGrants?: readonly string[];
  readonly weightLb?: number;
}

interface EncounterFixture {
  readonly id: string;
  readonly durationFrames: number;
  readonly enemies: readonly { x: number; y: number; hp: number }[];
}

interface BuildLevelResult {
  readonly buildId: string;
  readonly role: string;
  readonly level: LevelBand;
  readonly seed: number;
  readonly loadout: {
    readonly runKey: string;
    readonly rarity: GeneratedEquipmentRarity;
    readonly enhancement: 0 | 1 | 2 | 3 | 4 | 5;
    readonly weaponId: string;
    readonly weaponBaseDamage: number;
    readonly weaponCooldownMs: number;
    readonly weaponScale: number;
    readonly aoeRadius: number | null;
    readonly statBonuses: Readonly<Record<string, number>>;
    readonly abilityGrants: readonly string[];
    readonly weightLb: number | null;
  };
  readonly encounterDps: Readonly<Record<string, number>>;
  readonly encounterContributions: Readonly<
    Record<
      string,
      {
        readonly totalDamage: number;
        readonly contactDamage: number;
        readonly projectileDamage: number;
        readonly critDamage: number;
      }
    >
  >;
  readonly aggregateDps: number;
}

const LEVEL_RARITY_AND_ENHANCEMENT: Readonly<
  Record<LevelBand, { rarity: GeneratedEquipmentRarity; enhancement: 0 | 1 | 2 | 3 | 4 | 5 }>
> = {
  1: { rarity: 'common', enhancement: 0 },
  // Keep the representative mid-band on +1 so the 6→11 ratio gate is sensitive
  // to high-band growth instead of being dominated by fixture enhancement alone.
  6: { rarity: 'uncommon', enhancement: 1 },
  11: { rarity: 'rare', enhancement: 5 },
};

const BUILD_COHORT: readonly BuildArchetype[] = [
  {
    id: 'single-target',
    role: 'single-target',
    weaponId: 'sword',
    baseDamage: 16,
    cooldownMs: 320,
  },
  {
    id: 'aoe-cleave',
    role: 'aoe',
    weaponId: 'fireball',
    baseDamage: 12,
    cooldownMs: 420,
    aoeRadius: 6,
  },
  {
    id: 'cadence-crit',
    role: 'cadence/crit',
    weaponId: 'bow',
    baseDamage: 8,
    cooldownMs: 150,
    statBonuses: { critChance: 0.22 },
  },
  {
    id: 'active-ability',
    role: 'active-ability',
    weaponId: 'sword',
    baseDamage: 10,
    cooldownMs: 280,
    statBonuses: { intelligence: 4 },
    abilityGrants: ['fireball'],
  },
  {
    id: 'defensive-encumbrance',
    role: 'defensive/encumbrance',
    weaponId: 'baseball-bat',
    baseDamage: 11,
    cooldownMs: 370,
    statBonuses: { armor: 8, moveSpeed: -0.15 },
    weightLb: 30,
  },
] as const;

const ENCOUNTERS: readonly EncounterFixture[] = [
  {
    id: 'single-target-lane',
    durationFrames: 240,
    enemies: [{ x: 6, y: 0, hp: 20000 }],
  },
  {
    id: 'clustered-pack',
    durationFrames: 300,
    enemies: [
      { x: 5, y: 0, hp: 16000 },
      { x: 6, y: 1, hp: 16000 },
      { x: 6, y: -1, hp: 16000 },
      { x: 7, y: 0, hp: 16000 },
    ],
  },
] as const;

// Minimal production-combat seam for deterministic DPS fixtures:
// stat/status preprocessing + weapon fire during pre-systems, then ability
// triggers in post-systems. This preserves real runtime ordering.
const PRE_SYSTEMS = [statSystem, statusEffectSystem, weaponSystem] as const;
const POST_SYSTEMS = [abilitySystem] as const;
// Constitutional progression guard from issue #1567 / epic contract:
// representative-build median aggregate DPS ratios must stay within [1.7, 2.3]
// across level bands 1→6 and 6→11.
const DPS_RATIO_MIN = 1.7;
const DPS_RATIO_MAX = 2.3;
const ITEM_LEVEL_DAMAGE_STEP = 0.14;
const ITEM_LEVEL_DAMAGE_CURVE = 0.0045;

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('median requires at least one value');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function assertRatioInBounds(
  ratio: number,
  band: '1→6' | '6→11',
  diagnostics: Record<string, unknown>,
): void {
  const message = `level-band ${band} median ratio out of bounds [${DPS_RATIO_MIN},${DPS_RATIO_MAX}]\n${JSON.stringify(diagnostics, null, 2)}`;
  expect(ratio, message).toBeGreaterThanOrEqual(DPS_RATIO_MIN);
  expect(ratio, message).toBeLessThanOrEqual(DPS_RATIO_MAX);
}

function scaleStatBonus(stat: string, value: number, scale: number): number {
  if (stat === 'intelligence') {
    return Math.max(0, Math.round(value * scale));
  }
  if (value < 0) {
    return value;
  }
  return value * scale;
}

function computeBuildScale(
  world: GameWorld,
  level: LevelBand,
  rarity: GeneratedEquipmentRarity,
  enhancement: 0 | 1 | 2 | 3 | 4 | 5,
): number {
  // Deterministic fixture scaling derived from production policy knobs:
  // item-level term (linear + gentle quadratic curve), rarity inherent scalar,
  // and enhancement percent-per-level. This replaces the former hand-coded
  // per-band table + one-off archetype correction with a single uniform formula.
  const policy = world.generatedEquipmentRegistry.generationPolicy;
  const levelDelta = level - 1;
  const itemLevelScale =
    1 + levelDelta * ITEM_LEVEL_DAMAGE_STEP + levelDelta * levelDelta * ITEM_LEVEL_DAMAGE_CURVE;
  const rarityScale = policy.rarityInherentScalars[rarity];
  const enhancementScale = 1 + enhancement * policy.enhancementPercentPerLevel;
  return itemLevelScale * rarityScale * enhancementScale;
}

function exampleEffectsForRarity(
  rarity: GeneratedEquipmentRarity,
): GeneratedEquipmentCreateInputV1['resolvedEffects'] {
  if (rarity === 'common') return [];
  if (rarity === 'uncommon') {
    return [
      {
        schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
        effectId: 'rare-affix.crit',
        effectOrdinal: 0,
        unitCost: 1,
        kind: 'stat',
        stat: 'critChance',
        operation: 'add',
        value: 0.08,
      },
    ];
  }
  return [
    {
      schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      effectId: 'rare-affix.crit',
      effectOrdinal: 0,
      unitCost: 1,
      kind: 'stat',
      stat: 'critChance',
      operation: 'add',
      value: 0.1,
    },
    {
      schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      effectId: 'rare-affix.power',
      effectOrdinal: 1,
      unitCost: 1,
      kind: 'stat',
      stat: 'damageBonus',
      operation: 'add',
      value: 3,
    },
  ];
}

function equipFixtureBuild(
  world: GameWorld,
  player: number,
  build: BuildArchetype,
  level: LevelBand,
): BuildLevelResult['loadout'] {
  const weaponDef = getWeaponDef(build.weaponId);
  if (!weaponDef) throw new Error(`Missing weapon def for ${build.weaponId}`);
  const { rarity, enhancement } = LEVEL_RARITY_AND_ENHANCEMENT[level];
  const scale = computeBuildScale(world, level, rarity, enhancement);
  const runKey = world.generatedEquipmentRegistry.runKey ?? 'unknown';
  const weaponOrdinal = listGeneratedEquipmentInstances(world).length;
  const weaponInstanceId = generatedEquipmentInstanceKey(runKey, weaponOrdinal);
  const weaponSnapshot = createActiveWeaponSnapshotV1({ instanceId: weaponInstanceId }, weaponDef, {
    name: `${build.id}-l${level}`,
    baseDamage: Math.max(1, Math.round(build.baseDamage * scale)),
    cooldownMs: build.cooldownMs,
    ...(build.aoeRadius ? { aoeRadius: build.aoeRadius } : {}),
  });
  const weaponInstance = createGeneratedEquipmentInstance(world, {
    baseId: `weapon.${build.id}`,
    itemLevel: level,
    rarity,
    enhancementLevel: enhancement,
    resolvedEffects: exampleEffectsForRarity(rarity),
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: `${build.id}-weapon-l${level}`,
      artKey: `equipment.${build.id}.weapon`,
      slots: ['mainHand'],
      tags: ['weapon'],
      weightLb: 2,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: weaponSnapshot,
    },
  });
  expect(weaponInstance.instanceId).toBe(weaponInstanceId);
  expect(weaponInstance.frozen.activeWeaponSnapshot).toEqual(weaponSnapshot);
  setActiveWeapon(
    world,
    requireGeneratedEquipmentActiveWeaponSnapshot(world, weaponInstance.instanceId),
  );

  const statBonuses = Object.fromEntries(
    Object.entries(build.statBonuses ?? {}).map(([stat, value]) => [
      stat,
      scaleStatBonus(stat, value, scale),
    ]),
  );

  const ringInstance = createGeneratedEquipmentInstance(world, {
    baseId: `ring.${build.id}`,
    itemLevel: level,
    rarity,
    enhancementLevel: enhancement,
    resolvedEffects: exampleEffectsForRarity(rarity),
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: `${build.id}-ring-l${level}`,
      artKey: `equipment.${build.id}.ring`,
      slots: ['ring1'],
      tags: ['trinket'],
      weightLb: 1,
      statBonuses,
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: null,
    },
  });

  expect(addGeneratedEquipmentToBag(world, player, ringInstance.instanceId).ok).toBe(true);
  const ringEquipResult = equipFromBag(
    world,
    player,
    { kind: 'generated-instance', instanceKey: ringInstance.instanceId },
    { force: true },
  );
  expect(ringEquipResult.ok, JSON.stringify(ringEquipResult)).toBe(true);

  for (const abilityId of build.abilityGrants ?? []) {
    equipActiveAbility(world, player, abilityId);
  }

  if (build.weightLb !== undefined) {
    const bodyInstance = createGeneratedEquipmentInstance(world, {
      baseId: `armor.${build.id}`,
      itemLevel: level,
      rarity,
      enhancementLevel: enhancement,
      resolvedEffects: exampleEffectsForRarity(rarity),
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: `${build.id}-plate-l${level}`,
        artKey: `equipment.${build.id}.body`,
        slots: ['chest'],
        tags: ['armor'],
        weightLb: build.weightLb,
        statBonuses: { armor: 4 * scale },
        abilityGrants: [],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    });
    expect(addGeneratedEquipmentToBag(world, player, bodyInstance.instanceId).ok).toBe(true);
    const bodyEquipResult = equipFromBag(
      world,
      player,
      { kind: 'generated-instance', instanceKey: bodyInstance.instanceId },
      { force: true },
    );
    expect(bodyEquipResult.ok, JSON.stringify(bodyEquipResult)).toBe(true);
  }

  return {
    runKey,
    rarity,
    enhancement,
    weaponId: build.weaponId,
    weaponBaseDamage: Math.max(1, Math.round(build.baseDamage * scale)),
    weaponCooldownMs: build.cooldownMs,
    weaponScale: scale,
    aoeRadius: build.aoeRadius ?? null,
    statBonuses,
    abilityGrants: build.abilityGrants ?? [],
    weightLb: build.weightLb ?? null,
  };
}

function createEncounterContribution() {
  return {
    totalDamage: 0,
    contactDamage: 0,
    projectileDamage: 0,
    critDamage: 0,
  };
}

function runEncounter(
  world: GameWorld,
  encounter: EncounterFixture,
): { dps: number; contribution: ReturnType<typeof createEncounterContribution> } {
  const enemyIds = encounter.enemies.map((enemy) => spawnEnemy(world, enemy.x, enemy.y, enemy.hp));
  const enemyIdSet = new Set(enemyIds);
  const hpByEnemy = new Map(enemyIds.map((eid) => [eid, world.stores.health.current[eid] ?? 0]));
  const input = createInputState();
  const contribution = createEncounterContribution();
  let eventCursor = world.combatEvents.length;
  let damage = 0;
  for (let frame = 0; frame < encounter.durationFrames; frame += 1) {
    world.frameCount += 1;
    world.elapsedMs += GAME.DELTA_MS;
    runSimulationStep(world, input, { preSystems: PRE_SYSTEMS, postSystems: POST_SYSTEMS });
    for (let eventIndex = eventCursor; eventIndex < world.combatEvents.length; eventIndex += 1) {
      const event = world.combatEvents[eventIndex]!;
      if (
        event.type !== 'hit' ||
        event.targetType !== 'enemy' ||
        event.targetEid === undefined ||
        !enemyIdSet.has(event.targetEid)
      ) {
        continue;
      }
      contribution.totalDamage += event.amount;
      if (event.delivery === 'contact') contribution.contactDamage += event.amount;
      if (event.delivery === 'projectile') contribution.projectileDamage += event.amount;
      if (event.isCrit) contribution.critDamage += event.amount;
    }
    eventCursor = world.combatEvents.length;
    for (const eid of enemyIds) {
      const prev = hpByEnemy.get(eid) ?? 0;
      const next = Math.max(0, world.stores.health.current[eid] ?? 0);
      if (next < prev) damage += prev - next;
      hpByEnemy.set(eid, next);
      // Respawn immediately on defeat so each deterministic encounter measures a
      // sustained DPS stream over the full frame budget, not just time-to-first-kill.
      if (next <= 0) {
        const max = world.stores.health.max[eid] ?? 0;
        setComponent(world.ecs, eid, Health, { current: max, max });
        hpByEnemy.set(eid, max);
      }
    }
  }
  return {
    dps: damage / ((encounter.durationFrames * GAME.DELTA_MS) / 1000),
    contribution,
  };
}

function evaluateBuildLevel(build: BuildArchetype, level: LevelBand): BuildLevelResult {
  // Stable per build-level stream: base issue seed (1567) + level lane offset
  // (x100) + deterministic build id hash so replay and reorder checks are exact.
  const seed = 1567 + level * 100 + Math.abs(hashStringToSeed(build.id));
  const encounterResults = ENCOUNTERS.map((encounter) => {
    const encounterSeed = seed + Math.abs(hashStringToSeed(encounter.id));
    const world = createTestWorld({
      seed: encounterSeed,
      generatedEquipmentRunKey: `dps-${encounterSeed}-${build.id}-l${level}-${encounter.id}`,
    });
    world.floorMap = makeOpenFloorMap();
    world.featureUnlocks.spells = true;
    applyStartPlayerLevel(world, level);
    const player = spawnPlayer(world, 0, 0);
    const loadout = equipFixtureBuild(world, player, build, level);
    const result = runEncounter(world, encounter);
    return { encounterId: encounter.id, encounterSeed, loadout, result };
  });
  const first = encounterResults[0];
  if (!first) {
    throw new Error('Encounter fixtures must contain at least one entry');
  }
  const encounterDps = Object.fromEntries(
    encounterResults.map((entry) => [entry.encounterId, entry.result.dps]),
  );
  const encounterContributions = Object.fromEntries(
    encounterResults.map((entry) => [entry.encounterId, entry.result.contribution]),
  );
  const aggregateDps = median(Object.values(encounterDps));
  return {
    buildId: build.id,
    role: build.role,
    level,
    seed,
    loadout: first.loadout,
    encounterDps,
    encounterContributions,
    aggregateDps,
  };
}

function evaluateCohort(
  buildOrder: readonly BuildArchetype[],
): Record<LevelBand, BuildLevelResult[]> {
  return {
    1: buildOrder.map((build) => evaluateBuildLevel(build, 1)),
    6: buildOrder.map((build) => evaluateBuildLevel(build, 6)),
    11: buildOrder.map((build) => evaluateBuildLevel(build, 11)),
  };
}

describe('deterministic representative equipment DPS gate', () => {
  it('keeps median aggregate DPS ratios in constitutional bands for 1→6 and 6→11', () => {
    const cohort = evaluateCohort(BUILD_COHORT);
    const medians = {
      1: median(cohort[1].map((entry) => entry.aggregateDps)),
      6: median(cohort[6].map((entry) => entry.aggregateDps)),
      11: median(cohort[11].map((entry) => entry.aggregateDps)),
    };
    const ratioOneToSix = medians[6] / medians[1];
    const ratioSixToEleven = medians[11] / medians[6];
    const diagnostics = {
      medians,
      ratioOneToSix,
      ratioSixToEleven,
      perBuild: {
        1: cohort[1].map((entry) => ({
          build: entry.buildId,
          role: entry.role,
          seed: entry.seed,
          loadout: entry.loadout,
          aggregateDps: entry.aggregateDps,
          encounterDps: entry.encounterDps,
          encounterContributions: entry.encounterContributions,
        })),
        6: cohort[6].map((entry) => ({
          build: entry.buildId,
          role: entry.role,
          seed: entry.seed,
          loadout: entry.loadout,
          aggregateDps: entry.aggregateDps,
          encounterDps: entry.encounterDps,
          encounterContributions: entry.encounterContributions,
        })),
        11: cohort[11].map((entry) => ({
          build: entry.buildId,
          role: entry.role,
          seed: entry.seed,
          loadout: entry.loadout,
          aggregateDps: entry.aggregateDps,
          encounterDps: entry.encounterDps,
          encounterContributions: entry.encounterContributions,
        })),
      },
    };

    assertRatioInBounds(ratioOneToSix, '1→6', diagnostics);
    assertRatioInBounds(ratioSixToEleven, '6→11', diagnostics);
  });

  it('replays deterministically under repeated and reordered fixture execution', () => {
    const baseline = evaluateCohort(BUILD_COHORT);
    const replay = evaluateCohort(BUILD_COHORT);
    const reordered = evaluateCohort([...BUILD_COHORT].reverse());

    expect(replay).toEqual(baseline);
    for (const level of [1, 6, 11] as const) {
      expect([...reordered[level]].sort((a, b) => a.buildId.localeCompare(b.buildId))).toEqual(
        [...baseline[level]].sort((a, b) => a.buildId.localeCompare(b.buildId)),
      );
    }
  });
});
