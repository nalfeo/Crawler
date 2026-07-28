import { hasComponent, query } from 'bitecs';
import { Enemy, Health, Position } from '../components.js';
import { applyDamage } from '../apply-damage.js';
import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import type { GameWorld } from '../world.js';
import type { MobAbilityResolveContext, MobAbilityRuntimeDefinition } from './types.js';
import { launchMobAbilityProjectiles, spawnMobAbilityZone } from './runtime.js';

export const DON_PACO_BIG_GOB_ABILITY_ID = 'don-paco-the-big-gob';

const DAMAGE_PROFILE_AMOUNTS = {
  light: 10,
  moderate: 20,
  heavy: 35,
} as const;

const LANDING_RADIUS_FT = 3;
const PROJECTILE_TRAVEL_MS = 500;
const SLICK_SPEED_MULTIPLIER = 0.65;

type DamageProfile = keyof typeof DAMAGE_PROFILE_AMOUNTS;

interface CatalogDesignValue {
  readonly value: number | string | boolean;
  readonly unit: string;
}

interface BigGobTuning {
  readonly projectileCount: number;
  readonly coneAngleDeg: number;
  readonly rangeFt: number;
  readonly damageAmount: number;
  readonly slickDurationMs: number;
  readonly slowMultiplier: number;
}

function designValue(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.effect.designValues.find(
    (value: BossAbilityDef['effect']['designValues'][number]) => value.id === id,
  );
  if (found === undefined) {
    throw new Error(`THE BIG GOB catalog entry missing effect design value "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function metricValue(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.telegraph.metrics.find(
    (value: BossAbilityDef['telegraph']['metrics'][number]) => value.id === id,
  );
  if (found === undefined) {
    throw new Error(`THE BIG GOB telegraph is missing metric "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function asPositiveInt(entry: CatalogDesignValue, id: string, expectedUnit: string): number {
  if (entry.unit !== expectedUnit) {
    throw new Error(
      `THE BIG GOB value "${id}" must use unit "${expectedUnit}", got "${entry.unit}"`,
    );
  }
  if (typeof entry.value !== 'number' || !Number.isInteger(entry.value) || entry.value <= 0) {
    throw new Error(`THE BIG GOB value "${id}" must be a positive integer`);
  }
  return entry.value;
}

function asPositiveNumber(entry: CatalogDesignValue, id: string, expectedUnit: string): number {
  if (entry.unit !== expectedUnit) {
    throw new Error(
      `THE BIG GOB value "${id}" must use unit "${expectedUnit}", got "${entry.unit}"`,
    );
  }
  if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || entry.value <= 0) {
    throw new Error(`THE BIG GOB value "${id}" must be a positive finite number`);
  }
  return entry.value;
}

function asString(entry: CatalogDesignValue, id: string, expectedUnit: string): string {
  if (entry.unit !== expectedUnit) {
    throw new Error(
      `THE BIG GOB value "${id}" must use unit "${expectedUnit}", got "${entry.unit}"`,
    );
  }
  if (typeof entry.value !== 'string' || entry.value.length === 0) {
    throw new Error(`THE BIG GOB value "${id}" must be a non-empty string`);
  }
  return entry.value;
}

function readTuning(ability: BossAbilityDef): BigGobTuning {
  const projectileCount = asPositiveInt(
    metricValue(ability, 'projectile-count'),
    'projectile-count',
    'count',
  );
  const effectProjectileCount = asPositiveInt(
    designValue(ability, 'projectile-count'),
    'projectile-count',
    'count',
  );
  if (projectileCount !== effectProjectileCount) {
    throw new Error('THE BIG GOB telegraph and effect projectile-count must match');
  }
  const damageProfileRaw = asString(
    designValue(ability, 'damage-profile'),
    'damage-profile',
    'descriptor',
  );
  if (!(damageProfileRaw in DAMAGE_PROFILE_AMOUNTS)) {
    throw new Error(`THE BIG GOB has unknown damage-profile "${damageProfileRaw}"`);
  }
  const slowRule = asString(designValue(ability, 'slow-rule'), 'slow-rule', 'mode');
  if (slowRule !== 'while-inside') {
    throw new Error(`THE BIG GOB slow-rule must be "while-inside", got "${slowRule}"`);
  }
  return {
    projectileCount,
    coneAngleDeg: asPositiveNumber(metricValue(ability, 'angle'), 'angle', 'degrees'),
    rangeFt: asPositiveNumber(metricValue(ability, 'range'), 'range', 'feet'),
    damageAmount: DAMAGE_PROFILE_AMOUNTS[damageProfileRaw as DamageProfile],
    slickDurationMs: asPositiveInt(
      designValue(ability, 'slick-duration'),
      'slick-duration',
      'milliseconds',
    ),
    slowMultiplier: SLICK_SPEED_MULTIPLIER,
  };
}

function makeImpactHandler(ability: BossAbilityDef, tuning: BigGobTuning) {
  return (world: GameWorld, projectile: ReturnType<typeof buildProjectileShape>) => {
    const circle = projectile.circle;
    for (const eid of query(world.ecs, [Position, Health])) {
      if (eid === projectile.casterEid) continue;
      if (hasComponent(world.ecs, eid, Enemy)) continue;
      const dx = (world.stores.position.x[eid] ?? 0) - circle.x;
      const dy = (world.stores.position.y[eid] ?? 0) - circle.y;
      if (dx * dx + dy * dy > circle.radiusFt * circle.radiusFt) continue;
      const targetX = world.stores.position.x[eid] ?? 0;
      const targetY = world.stores.position.y[eid] ?? 0;
      applyDamage(world, eid, tuning.damageAmount, targetX, targetY, {
        origin: 'enemy',
        affinity: 'magic',
        scaleWithPrimary: false,
        canCrit: false,
        sourceEid: projectile.casterEid,
        sourceX: circle.x,
        sourceY: circle.y,
      });
    }
    spawnMobAbilityZone(world, {
      abilityId: ability.id,
      casterEid: projectile.casterEid,
      sourceId: `${projectile.sourceId}:slick`,
      x: circle.x,
      y: circle.y,
      radiusFt: circle.radiusFt,
      durationMs: tuning.slickDurationMs,
      slowMultiplier: tuning.slowMultiplier,
    });
  };
}

function buildProjectileShape(projectile: {
  readonly casterEid: number;
  readonly sourceId: string;
  readonly path: { readonly endX: number; readonly endY: number; readonly impactRadiusFt: number };
}) {
  return {
    casterEid: projectile.casterEid,
    sourceId: projectile.sourceId,
    circle: {
      x: projectile.path.endX,
      y: projectile.path.endY,
      radiusFt: projectile.path.impactRadiusFt,
    },
  };
}

function makeResolveHandler(ability: BossAbilityDef, tuning: BigGobTuning) {
  const handleImpact = makeImpactHandler(ability, tuning);
  return function resolveBigGob(world: GameWorld, ctx: MobAbilityResolveContext): void {
    if (ctx.geometry.kind !== 'projectile-fan') return;
    launchMobAbilityProjectiles(world, {
      abilityId: ability.id,
      casterEid: ctx.casterEid,
      sourceId: ctx.sourceId,
      paths: ctx.geometry.paths,
      damageAmount: tuning.damageAmount,
      zoneDurationMs: tuning.slickDurationMs,
      slowMultiplier: tuning.slowMultiplier,
      travelDurationMs: PROJECTILE_TRAVEL_MS,
      onImpact: (impactWorld, projectile) =>
        handleImpact(impactWorld, buildProjectileShape(projectile)),
    });
  };
}

export function createDonPacoBigGobDefinition(): MobAbilityRuntimeDefinition {
  const ability = getFloor2BossAbilityById(DON_PACO_BIG_GOB_ABILITY_ID);
  if (ability === undefined) {
    throw new Error(`Catalog is missing ability "${DON_PACO_BIG_GOB_ABILITY_ID}"`);
  }
  const tuning = readTuning(ability);
  return {
    abilityId: ability.id,
    bossArchetypeKey: ability.bossArchetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
    geometry: {
      kind: 'projectile-fan',
      count: tuning.projectileCount,
      coneAngleDeg: tuning.coneAngleDeg,
      rangeFt: tuning.rangeFt,
      impactRadiusFt: LANDING_RADIUS_FT,
    },
    targetingMode: 'player-direction',
    resolve: makeResolveHandler(ability, tuning),
  };
}
