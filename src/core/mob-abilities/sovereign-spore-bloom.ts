import { hasComponent, query } from 'bitecs';
import { Enemy, Health, Position } from '../components.js';
import { applyDamage } from '../apply-damage.js';
import type { GameWorld } from '../world.js';
import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import {
  mobAbilityGeometryCircles,
  type MobAbilityCircleGeometry,
  type MobAbilityGeometry,
  type MobAbilityResolveContext,
  type MobAbilityRuntimeDefinition,
} from './types.js';
import { registerMobAbilityOwnedZone } from './runtime.js';

export const SOVEREIGN_SPORE_BLOOM_ABILITY_ID = 'sovereign-cap-spore-bloom';

const IMPACT_DAMAGE_BY_PROFILE = {
  light: 10,
  moderate: 20,
  heavy: 35,
} as const;

const CLOUD_DAMAGE_BY_PROFILE = {
  'light-repeated': 6,
} as const;

const CLOUD_TICK_INTERVAL_MS = 500;
const TRIANGLE_OFFSET_MULTIPLIER = 0.75;

interface CatalogDesignValue {
  readonly value: number | string | boolean;
  readonly unit: string;
}

interface SporeBloomTuning {
  readonly zoneCount: number;
  readonly impactDamage: number;
  readonly cloudDamage: number;
  readonly cloudDurationMs: number;
}

function designValue(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.effect.designValues.find((value) => value.id === id);
  if (found === undefined) {
    throw new Error(`Sovereign Spore Bloom catalog entry missing effect design value "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function expectUnit(actualUnit: string, expectedUnit: string, id: string): void {
  if (actualUnit !== expectedUnit) {
    throw new Error(
      `Sovereign Spore Bloom design value "${id}" must use unit "${expectedUnit}", got "${actualUnit}"`,
    );
  }
}

function asNumber(entry: CatalogDesignValue, id: string, expectedUnit: string): number {
  expectUnit(entry.unit, expectedUnit, id);
  const value = entry.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Sovereign Spore Bloom design value "${id}" must be a finite number`);
  }
  return value;
}

function asString(entry: CatalogDesignValue, id: string, expectedUnit: string): string {
  expectUnit(entry.unit, expectedUnit, id);
  if (typeof entry.value !== 'string' || entry.value.length === 0) {
    throw new Error(`Sovereign Spore Bloom design value "${id}" must be a non-empty string`);
  }
  return entry.value;
}

function readRadiusFt(ability: BossAbilityDef): number {
  const metric = ability.telegraph.metrics.find((m) => m.id === 'radius');
  if (metric === undefined || typeof metric.value !== 'number' || metric.unit !== 'feet') {
    throw new Error('Sovereign Spore Bloom telegraph is missing a numeric "radius" metric in feet');
  }
  if (metric.value <= 0) {
    throw new Error('Sovereign Spore Bloom telegraph radius must be > 0 feet');
  }
  return metric.value;
}

function readTuning(ability: BossAbilityDef): SporeBloomTuning {
  const zoneCount = asNumber(designValue(ability, 'zone-count'), 'zone-count', 'count');
  if (!Number.isInteger(zoneCount) || zoneCount <= 0) {
    throw new Error('Sovereign Spore Bloom zone-count must be a positive integer');
  }
  const impactProfile = asString(
    designValue(ability, 'impact-damage-profile'),
    'impact-damage-profile',
    'descriptor',
  );
  const impactDamage =
    IMPACT_DAMAGE_BY_PROFILE[impactProfile as keyof typeof IMPACT_DAMAGE_BY_PROFILE];
  if (impactDamage === undefined) {
    throw new Error(`Sovereign Spore Bloom has unknown impact-damage-profile "${impactProfile}"`);
  }
  const cloudProfile = asString(
    designValue(ability, 'cloud-damage-profile'),
    'cloud-damage-profile',
    'descriptor',
  );
  const cloudDamage = CLOUD_DAMAGE_BY_PROFILE[cloudProfile as keyof typeof CLOUD_DAMAGE_BY_PROFILE];
  if (cloudDamage === undefined) {
    throw new Error(`Sovereign Spore Bloom has unknown cloud-damage-profile "${cloudProfile}"`);
  }
  const cloudDurationMs = asNumber(
    designValue(ability, 'cloud-duration'),
    'cloud-duration',
    'milliseconds',
  );
  if (cloudDurationMs <= 0) {
    throw new Error('Sovereign Spore Bloom cloud-duration must be > 0');
  }
  return { zoneCount, impactDamage, cloudDamage, cloudDurationMs };
}

function pointInCircle(x: number, y: number, circle: MobAbilityCircleGeometry): boolean {
  const dx = x - circle.x;
  const dy = y - circle.y;
  return dx * dx + dy * dy <= circle.radiusFt * circle.radiusFt;
}

function pointInGeometry(x: number, y: number, geometry: MobAbilityGeometry): boolean {
  for (const circle of mobAbilityGeometryCircles(geometry)) {
    if (pointInCircle(x, y, circle)) {
      return true;
    }
  }
  return false;
}

function applyGeometryDamage(
  world: GameWorld,
  geometry: MobAbilityGeometry,
  casterEid: number,
  amount: number,
): void {
  for (const eid of query(world.ecs, [Position, Health])) {
    if (eid === casterEid) continue;
    if (hasComponent(world.ecs, eid, Enemy)) continue;
    const x = world.stores.position.x[eid] ?? 0;
    const y = world.stores.position.y[eid] ?? 0;
    if (!pointInGeometry(x, y, geometry)) continue;
    applyDamage(world, eid, amount, x, y, {
      origin: 'enemy',
      affinity: 'magic',
      scaleWithPrimary: false,
      canCrit: false,
      sourceEid: casterEid,
      sourceX: x,
      sourceY: y,
    });
  }
}

function commitTriangleGeometry(
  lockedX: number,
  lockedY: number,
  radiusFt: number,
  count: number,
): MobAbilityGeometry {
  const offsetFt = radiusFt * TRIANGLE_OFFSET_MULTIPLIER;
  const circles: MobAbilityCircleGeometry[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = -Math.PI / 2 + (i / count) * Math.PI * 2;
    circles.push({
      kind: 'circle',
      x: lockedX + Math.cos(angle) * offsetFt,
      y: lockedY + Math.sin(angle) * offsetFt,
      radiusFt,
    });
  }
  return { kind: 'multi-circle', circles };
}

function makeResolveHandler(ability: BossAbilityDef, tuning: SporeBloomTuning) {
  return function resolveSovereignSporeBloom(
    world: GameWorld,
    ctx: MobAbilityResolveContext,
  ): void {
    const geometry: MobAbilityGeometry =
      ctx.geometry.kind === 'multi-circle'
        ? ctx.geometry
        : {
            kind: 'multi-circle' as const,
            circles: mobAbilityGeometryCircles(ctx.geometry),
          };
    applyGeometryDamage(world, geometry, ctx.casterEid, tuning.impactDamage);
    registerMobAbilityOwnedZone(world, {
      abilityId: ability.id,
      casterEid: ctx.casterEid,
      sourceId: ctx.sourceId,
      geometry,
      durationMs: tuning.cloudDurationMs,
      tickIntervalMs: CLOUD_TICK_INTERVAL_MS,
      tick: (zoneWorld, zone) => {
        applyGeometryDamage(zoneWorld, zone.geometry, zone.casterEid, tuning.cloudDamage);
      },
    });
  };
}

export function createSovereignSporeBloomDefinition(): MobAbilityRuntimeDefinition {
  const ability = getFloor2BossAbilityById(SOVEREIGN_SPORE_BLOOM_ABILITY_ID);
  if (ability === undefined) {
    throw new Error(`Catalog is missing ability "${SOVEREIGN_SPORE_BLOOM_ABILITY_ID}"`);
  }
  const radiusFt = readRadiusFt(ability);
  const tuning = readTuning(ability);
  return {
    abilityId: ability.id,
    bossArchetypeKey: ability.bossArchetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
    geometry: { kind: 'circle', radiusFt },
    commitGeometry: ({ lockedX, lockedY }) =>
      commitTriangleGeometry(lockedX, lockedY, radiusFt, tuning.zoneCount),
    resolve: makeResolveHandler(ability, tuning),
  };
}
