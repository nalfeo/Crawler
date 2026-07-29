import { hasComponent, removeComponent } from 'bitecs';
import { applyDamage } from '../apply-damage.js';
import { Health, Knockback, Player, Position, Velocity } from '../components.js';
import { getBodyHalfHeight, getBodyHalfWidth } from '../physics-body.js';
import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import type { GameWorld } from '../world.js';
import { activateMobAbilityRecovery } from './runtime.js';
import type { MobAbilityResolveContext, MobAbilityRuntimeDefinition } from './types.js';

export const TONGUE_REPOSSESSION_ABILITY_ID = 'big-mama-bufo-tongue-repossession';

const DAMAGE_PROFILE_AMOUNTS = {
  light: 10,
  moderate: 20,
  heavy: 35,
} as const;
type DamageProfile = keyof typeof DAMAGE_PROFILE_AMOUNTS;

interface CatalogDesignValue {
  readonly value: number | string | boolean;
  readonly unit: string;
}

interface TongueRepossessionTuning {
  readonly widthFt: number;
  readonly maxRangeFt: number;
  readonly pullEndDistanceFt: number;
  readonly damageAmount: number;
  readonly missRecoveryMs: number;
}

const PULL_SUBSTEP_FT = 0.125;

function designValue(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.effect.designValues.find((value) => value.id === id);
  if (found === undefined) {
    throw new Error(`Tongue Repossession catalog entry missing effect design value "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function asFeetNumber(value: CatalogDesignValue, id: string): number {
  if (value.unit !== 'feet') {
    throw new Error(`Tongue Repossession design value "${id}" must use unit "feet"`);
  }
  if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value <= 0) {
    throw new Error(`Tongue Repossession design value "${id}" must be a positive number`);
  }
  return value.value;
}

function asDamageProfile(value: CatalogDesignValue, id: string): DamageProfile {
  if (value.unit !== 'descriptor') {
    throw new Error(`Tongue Repossession design value "${id}" must use unit "descriptor"`);
  }
  if (typeof value.value !== 'string' || !(value.value in DAMAGE_PROFILE_AMOUNTS)) {
    throw new Error(`Tongue Repossession design value "${id}" must be a known damage profile`);
  }
  return value.value as DamageProfile;
}

function readTelegraphMetricFeet(ability: BossAbilityDef, id: string): number {
  const metric = ability.telegraph.metrics.find((entry) => entry.id === id);
  if (metric === undefined || metric.unit !== 'feet') {
    throw new Error(`Tongue Repossession telegraph must include "${id}" in feet`);
  }
  if (typeof metric.value !== 'number' || !Number.isFinite(metric.value) || metric.value <= 0) {
    throw new Error(`Tongue Repossession telegraph metric "${id}" must be a positive number`);
  }
  return metric.value;
}

function readTuning(ability: BossAbilityDef): TongueRepossessionTuning {
  const widthFt = readTelegraphMetricFeet(ability, 'width');
  const telegraphMaxRangeFt = readTelegraphMetricFeet(ability, 'max-range');
  const effectMaxRangeFt = asFeetNumber(designValue(ability, 'max-range'), 'max-range');
  if (Math.abs(effectMaxRangeFt - telegraphMaxRangeFt) > 1e-6) {
    throw new Error('Tongue Repossession telegraph/effect max-range values must match');
  }
  const pullEndDistanceFt = asFeetNumber(
    designValue(ability, 'pull-end-distance'),
    'pull-end-distance',
  );
  if (pullEndDistanceFt >= telegraphMaxRangeFt) {
    throw new Error('Tongue Repossession pull-end-distance must be smaller than max-range');
  }
  const damageProfile = asDamageProfile(designValue(ability, 'damage-profile'), 'damage-profile');
  return {
    widthFt,
    maxRangeFt: telegraphMaxRangeFt,
    pullEndDistanceFt,
    damageAmount: DAMAGE_PROFILE_AMOUNTS[damageProfile],
    missRecoveryMs: ability.telegraph.durationMs,
  };
}

function sqDistanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const vv = vx * vx + vy * vy;
  if (vv <= Number.EPSILON) {
    const dx = px - x1;
    const dy = py - y1;
    return dx * dx + dy * dy;
  }
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
  const cx = x1 + t * vx;
  const cy = y1 + t * vy;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function isFootprintPassable(world: GameWorld, eid: number, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) return true;
  const halfWidth = getBodyHalfWidth(world, eid, 'tongueRepossession');
  const halfHeight = getBodyHalfHeight(world, eid, 'tongueRepossession');
  const epsilon = 0.001;
  const left = x - halfWidth + epsilon;
  const right = x + halfWidth - epsilon;
  const top = y - halfHeight + epsilon;
  const bottom = y + halfHeight - epsilon;
  return (
    floorMap.isPassableAt(left, top) &&
    floorMap.isPassableAt(right, top) &&
    floorMap.isPassableAt(left, bottom) &&
    floorMap.isPassableAt(right, bottom)
  );
}

function moveToSafePullPosition(
  world: GameWorld,
  eid: number,
  desiredX: number,
  desiredY: number,
  fromX: number,
  fromY: number,
): void {
  const dx = desiredX - fromX;
  const dy = desiredY - fromY;
  const distance = Math.hypot(dx, dy);
  if (distance <= Number.EPSILON) return;

  const steps = Math.max(1, Math.ceil(distance / PULL_SUBSTEP_FT));
  let safeX = fromX;
  let safeY = fromY;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const candidateX = fromX + dx * t;
    const candidateY = fromY + dy * t;
    if (!isFootprintPassable(world, eid, candidateX, candidateY)) {
      break;
    }
    safeX = candidateX;
    safeY = candidateY;
  }
  world.stores.position.x[eid] = safeX;
  world.stores.position.y[eid] = safeY;
}

function makeResolveHandler(tuning: TongueRepossessionTuning) {
  return function resolveTongueRepossession(world: GameWorld, ctx: MobAbilityResolveContext): void {
    if (ctx.geometry.kind !== 'lane' || ctx.targetEid === null) return;
    const target = ctx.targetEid;
    if (!hasComponent(world.ecs, target, Player) || !hasComponent(world.ecs, target, Position))
      return;
    const targetX = world.stores.position.x[target] ?? 0;
    const targetY = world.stores.position.y[target] ?? 0;
    const halfWidth = getBodyHalfWidth(world, target, 'tongueRepossession');
    const halfHeight = getBodyHalfHeight(world, target, 'tongueRepossession');
    const bodyRadius = Math.max(halfWidth, halfHeight);
    const laneHalfWidth = ctx.geometry.widthFt * 0.5;
    const hitSq = sqDistanceToSegment(
      targetX,
      targetY,
      ctx.geometry.originX,
      ctx.geometry.originY,
      ctx.geometry.endX,
      ctx.geometry.endY,
    );
    const hitRadius = laneHalfWidth + bodyRadius;
    if (hitSq > hitRadius * hitRadius) {
      activateMobAbilityRecovery(world, {
        abilityId: ctx.abilityId,
        casterEid: ctx.casterEid,
        sourceId: ctx.sourceId,
        durationMs: tuning.missRecoveryMs,
      });
      return;
    }

    applyDamage(world, target, tuning.damageAmount, targetX, targetY, {
      origin: 'enemy',
      affinity: 'physical',
      scaleWithPrimary: false,
      canCrit: false,
      sourceEid: ctx.casterEid,
      sourceX: ctx.geometry.originX,
      sourceY: ctx.geometry.originY,
    });
    if (!hasComponent(world.ecs, target, Health)) return;
    if ((world.stores.health.current[target] ?? 0) <= 0) return;

    const pullX = ctx.geometry.originX + ctx.geometry.dirX * tuning.pullEndDistanceFt;
    const pullY = ctx.geometry.originY + ctx.geometry.dirY * tuning.pullEndDistanceFt;
    moveToSafePullPosition(world, target, pullX, pullY, targetX, targetY);
    if (hasComponent(world.ecs, target, Velocity)) {
      world.stores.velocity.x[target] = 0;
      world.stores.velocity.y[target] = 0;
    }
    if (hasComponent(world.ecs, target, Knockback)) {
      removeComponent(world.ecs, target, Knockback);
    }
  };
}

export function createTongueRepossessionDefinition(): MobAbilityRuntimeDefinition {
  const ability = getFloor2BossAbilityById(TONGUE_REPOSSESSION_ABILITY_ID);
  if (ability === undefined) {
    throw new Error(`Catalog is missing ability "${TONGUE_REPOSSESSION_ABILITY_ID}"`);
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
      kind: 'lane',
      widthFt: tuning.widthFt,
      maxRangeFt: tuning.maxRangeFt,
    },
    resolve: makeResolveHandler(tuning),
  };
}
