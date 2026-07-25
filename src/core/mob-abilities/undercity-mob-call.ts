import { addComponent, set, setComponent } from 'bitecs';
import { Damage, FamilyMembership, Size, Sprite } from '../components.js';
import { SHAPE_CIRCLE } from '../physics-defs.js';
import { spawnBehaviorEnemy, setEnemyAppearanceKey } from '../spawners/combatants.js';
import { floor2EnemyPack } from '../../shared/enemy-packs.js';
import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import { loadFamilies } from '../../shared/data/families.js';
import type { GameWorld } from '../world.js';
import type { MobAbilityResolveContext, MobAbilityRuntimeDefinition } from './types.js';

export const UNDERCITY_MOB_CALL_ABILITY_ID = 'plague-boss-squick-undercity-mob-call';

const AI_TYPE = { CHASE: 0, RANGED: 2 } as const;
const RATFOLK_FAMILY_INDEX = loadFamilies().findIndex((family) => family.id === 'ratfolk');
const DEFAULT_SPAWN_DISTANCE_MULTIPLIER = 2;

interface CatalogDesignValue {
  readonly value: number | string | boolean;
  readonly unit: string;
}

interface UndercityMobCallTuning {
  readonly summonCount: number;
  readonly ownedMinionCap: number;
  readonly summonArchetypeId: string;
}

function designValue(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.effect.designValues.find((value) => value.id === id);
  if (found === undefined) {
    throw new Error(`Undercity Mob Call catalog entry missing effect design value "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function asPositiveInt(entry: CatalogDesignValue, id: string, expectedUnit: string): number {
  if (entry.unit !== expectedUnit) {
    throw new Error(
      `Undercity Mob Call design value "${id}" must use unit "${expectedUnit}", got "${entry.unit}"`,
    );
  }
  if (typeof entry.value !== 'number' || !Number.isInteger(entry.value) || entry.value <= 0) {
    throw new Error(`Undercity Mob Call design value "${id}" must be a positive integer`);
  }
  return entry.value;
}

function readTelegraphCount(ability: BossAbilityDef): number {
  const metric = ability.telegraph.metrics.find((value) => value.id === 'count');
  if (metric === undefined || metric.unit !== 'count') {
    throw new Error('Undercity Mob Call telegraph must include a "count" metric in unit "count"');
  }
  if (typeof metric.value !== 'number' || !Number.isInteger(metric.value) || metric.value <= 0) {
    throw new Error('Undercity Mob Call telegraph count must be a positive integer');
  }
  return metric.value;
}

function readRadiusFt(ability: BossAbilityDef): number {
  const metric = ability.telegraph.metrics.find((value) => value.id === 'radius');
  if (metric === undefined || metric.unit !== 'feet' || typeof metric.value !== 'number') {
    throw new Error('Undercity Mob Call telegraph must include a numeric "radius" metric in feet');
  }
  if (metric.value <= 0) {
    throw new Error('Undercity Mob Call telegraph radius must be > 0 feet');
  }
  return metric.value;
}

function readTuning(ability: BossAbilityDef): UndercityMobCallTuning {
  const summonCount = asPositiveInt(designValue(ability, 'summon-count'), 'summon-count', 'count');
  const ownedMinionCap = asPositiveInt(
    designValue(ability, 'owned-minion-cap'),
    'owned-minion-cap',
    'count',
  );
  return {
    summonCount,
    ownedMinionCap,
    summonArchetypeId: 'ratfolk-plague',
  };
}

if (RATFOLK_FAMILY_INDEX < 0) {
  throw new Error('Undercity Mob Call requires the ratfolk family id in families data');
}

function resolveAiType(aiType: string): number {
  if (aiType === 'ranged') return AI_TYPE.RANGED;
  return AI_TYPE.CHASE;
}

function makeResolveHandler(ability: BossAbilityDef) {
  const tuning = readTuning(ability);
  const archetype = floor2EnemyPack.archetypes.find((candidate) => candidate.id === tuning.summonArchetypeId);
  if (archetype === undefined) {
    throw new Error(`Undercity Mob Call summon archetype "${tuning.summonArchetypeId}" is missing`);
  }
  const attackRange = archetype.aiType === 'ranged' ? archetype.detectRange * 0.65 : 0;

  return function resolveUndercityMobCall(world: GameWorld, ctx: MobAbilityResolveContext): void {
    if (ctx.geometry.kind !== 'spawn-circles') return;
    const ownedLiving = ctx.countOwnedLiving?.() ?? 0;
    const remainingSlots = Math.max(0, tuning.ownedMinionCap - ownedLiving);
    const toSummon = Math.min(tuning.summonCount, remainingSlots, ctx.geometry.circles.length);
    for (let i = 0; i < toSummon; i += 1) {
      const circle = ctx.geometry.circles[i]!;
      const eid = spawnBehaviorEnemy(
        world,
        circle.x,
        circle.y,
        archetype.hp,
        resolveAiType(archetype.aiType),
        archetype.speed,
        archetype.detectRange,
        attackRange,
      );
      setComponent(world.ecs, eid, Sprite, {
        textureId: archetype.spriteTexture,
        width: archetype.spriteWidth,
        height: archetype.spriteHeight,
      });
      setComponent(world.ecs, eid, Size, {
        radius:
          archetype.collisionRadius ??
          Math.max(archetype.spriteWidth, archetype.spriteHeight) * 0.5,
        halfWidth: 0,
        halfHeight: 0,
        shape: SHAPE_CIRCLE,
      });
      setEnemyAppearanceKey(world, eid, archetype.id);
      setComponent(world.ecs, eid, Damage, { amount: 1 });
      addComponent(world.ecs, eid, set(FamilyMembership, { familyId: RATFOLK_FAMILY_INDEX, isBoss: 0 }));
      ctx.registerOwnedEntity?.(eid);
    }
  };
}

export function createUndercityMobCallDefinition(): MobAbilityRuntimeDefinition {
  const ability = getFloor2BossAbilityById(UNDERCITY_MOB_CALL_ABILITY_ID);
  if (ability === undefined) {
    throw new Error(`Catalog is missing ability "${UNDERCITY_MOB_CALL_ABILITY_ID}"`);
  }
  const telegraphCount = readTelegraphCount(ability);
  const tuning = readTuning(ability);
  if (telegraphCount !== tuning.summonCount) {
    throw new Error('Undercity Mob Call telegraph count must match summon-count');
  }
  const radiusFt = readRadiusFt(ability);
  return {
    abilityId: ability.id,
    bossArchetypeKey: ability.bossArchetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
    geometry: {
      kind: 'spawn-circles',
      count: telegraphCount,
      radiusFt,
      distanceFromCasterFt: radiusFt * DEFAULT_SPAWN_DISTANCE_MULTIPLIER,
    },
    resolve: makeResolveHandler(ability),
  };
}
