import { addComponent, hasComponent, query, removeComponent, set } from 'bitecs';
import { applyDamage } from '../apply-damage.js';
import { Health, Knockback, Player, Position } from '../components.js';
import { getBodyHalfHeight, getBodyHalfWidth } from '../physics-body.js';
import { recoverStolenGoldAt } from '../spawners/pickups.js';
import type { GameWorld } from '../world.js';
import { GAME } from '../../shared/constants.js';
import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import { activateMobAbilityRecovery, registerMobAbilityOwnedZone } from './runtime.js';
import {
  pushMobAbilityBurst,
  type MobAbilityGeometry,
  type MobAbilityLaneGeometry,
  type MobAbilityResolveContext,
  type MobAbilityRuntimeDefinition,
} from './types.js';

const TRAVEL_SPEED_FT_PER_SECOND = 40;
const PATH_STEP_FT = 0.125;
const STRONG_KNOCKBACK_FT = 5;
const FIRE_TICK_MS = 500;

function catalog(id: string): BossAbilityDef {
  const ability = getFloor2BossAbilityById(id);
  if (!ability) throw new Error(`Missing Floor 2 ability ${id}`);
  return ability;
}

function numberValue(ability: BossAbilityDef, id: string, unit: string, metric = false): number {
  const entries = metric ? ability.telegraph.metrics : ability.effect.designValues;
  const entry = entries.find((value) => value.id === id);
  if (
    !entry ||
    entry.unit !== unit ||
    typeof entry.value !== 'number' ||
    !Number.isFinite(entry.value) ||
    entry.value <= 0
  )
    throw new Error(`${ability.id}: ${id} must be positive ${unit}`);
  return entry.value;
}

function requireValue(
  ability: BossAbilityDef,
  id: string,
  value: string | boolean,
  metric = false,
): void {
  const entries = metric ? ability.telegraph.metrics : ability.effect.designValues;
  if (entries.find((entry) => entry.id === id)?.value !== value)
    throw new Error(`${ability.id}: unsupported ${id}`);
}

function base(ability: BossAbilityDef): Omit<MobAbilityRuntimeDefinition, 'geometry' | 'resolve'> {
  return {
    abilityId: ability.id,
    bossArchetypeKey: ability.bossArchetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
    targetingMode: 'player-position',
    originMode: 'locked',
    lockCasterDuringTelegraph: true,
  };
}

/** Test every tile touched by the body, including tiles between its corners. */
function passable(world: GameWorld, eid: number, x: number, y: number): boolean {
  const map = world.floorMap;
  if (!map) return true;
  const hw = getBodyHalfWidth(world, eid, 'floor2LaneAbilities');
  const hh = getBodyHalfHeight(world, eid, 'floor2LaneAbilities');
  const sx = Math.max(1, Math.ceil((hw * 2) / (map.config.tileSizeFt / 2)));
  const sy = Math.max(1, Math.ceil((hh * 2) / (map.config.tileSizeFt / 2)));
  for (let ix = 0; ix <= sx; ix++) {
    for (let iy = 0; iy <= sy; iy++) {
      if (
        !map.isPassableAt(
          x - hw + 0.001 + ((hw * 2 - 0.002) * ix) / sx,
          y - hh + 0.001 + ((hh * 2 - 0.002) * iy) / sy,
        )
      )
        return false;
    }
  }
  return true;
}

function safeDistance(
  world: GameWorld,
  eid: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  distance: number,
): number {
  let safe = 0;
  const steps = Math.max(1, Math.ceil(distance / PATH_STEP_FT));
  for (let i = 1; i <= steps; i++) {
    const candidate = (distance * i) / steps;
    if (!passable(world, eid, x + dx * candidate, y + dy * candidate)) break;
    safe = candidate;
  }
  return safe;
}

function lane(
  x: number,
  y: number,
  dx: number,
  dy: number,
  distance: number,
  width: number,
): MobAbilityLaneGeometry {
  return {
    kind: 'lane',
    originX: x,
    originY: y,
    endX: x + dx * distance,
    endY: y + dy * distance,
    dirX: dx,
    dirY: dy,
    lengthFt: distance,
    widthFt: width,
  };
}

function extent(world: GameWorld): number {
  return world.floorMap ? Math.hypot(world.floorMap.widthFt, world.floorMap.heightFt) : 64;
}

function commitLane(
  world: GameWorld,
  caster: number,
  tx: number,
  ty: number,
  width: number,
  maxRange: number,
  stopAtTarget: boolean,
): MobAbilityLaneGeometry {
  const x = world.stores.position.x[caster] ?? 0;
  const y = world.stores.position.y[caster] ?? 0;
  const length = Math.hypot(tx - x, ty - y);
  const dx = length > 0.001 ? (tx - x) / length : 1;
  const dy = length > 0.001 ? (ty - y) / length : 0;
  const distance = safeDistance(
    world,
    caster,
    x,
    y,
    dx,
    dy,
    stopAtTarget ? Math.min(length, maxRange) : maxRange,
  );
  return lane(x, y, dx, dy, distance, width);
}

function inside(world: GameWorld, eid: number, geometry: MobAbilityGeometry): boolean {
  const x = world.stores.position.x[eid] ?? 0;
  const y = world.stores.position.y[eid] ?? 0;
  if (geometry.kind === 'circle')
    return Math.hypot(x - geometry.x, y - geometry.y) <= geometry.radiusFt;
  if (geometry.kind !== 'lane') return false;
  const along = (x - geometry.originX) * geometry.dirX + (y - geometry.originY) * geometry.dirY;
  const across = Math.abs(
    (x - geometry.originX) * geometry.dirY - (y - geometry.originY) * geometry.dirX,
  );
  return along >= 0 && along <= geometry.lengthFt && across <= geometry.widthFt / 2;
}

function hit(
  world: GameWorld,
  ctx: MobAbilityResolveContext,
  geometry: MobAbilityGeometry,
  amount: number,
  onHit?: (eid: number) => void,
  hitSet?: Set<number>,
): void {
  for (const eid of query(world.ecs, [Player, Position, Health])) {
    if (
      (world.stores.health.current[eid] ?? 0) <= 0 ||
      hitSet?.has(eid) ||
      !inside(world, eid, geometry)
    )
      continue;
    // A dash attempts each target once; a dodge must not turn into dozens of rerolls.
    hitSet?.add(eid);
    const dealt = applyDamage(
      world,
      eid,
      amount,
      world.stores.position.x[eid]!,
      world.stores.position.y[eid]!,
      {
        origin: 'enemy',
        affinity: 'physical',
        scaleWithPrimary: false,
        canCrit: false,
        sourceEid: ctx.casterEid,
        sourceX: world.stores.position.x[ctx.casterEid] ?? 0,
        sourceY: world.stores.position.y[ctx.casterEid] ?? 0,
      },
    );
    if (dealt > 0) onHit?.(eid);
  }
}

function knockback(world: GameWorld, eid: number, dx: number, dy: number): void {
  const length = Math.hypot(dx, dy);
  addComponent(
    world.ecs,
    eid,
    set(Knockback, {
      dirX: length > 0.001 ? dx / length : 1,
      dirY: length > 0.001 ? dy / length : 0,
      remaining: STRONG_KNOCKBACK_FT,
      speed: 0.5,
    }),
  );
}

function resolveTravel(
  world: GameWorld,
  ctx: MobAbilityResolveContext,
  route: MobAbilityLaneGeometry,
  mode: 'cart' | 'burrow' | 'robbery',
  maxGold = 0,
  eruptionRadius = 0,
): void {
  const duration =
    Math.max(1, Math.ceil(((route.lengthFt / TRAVEL_SPEED_FT_PER_SECOND) * 1000) / GAME.DELTA_MS)) *
    GAME.DELTA_MS;
  const hits = new Set<number>();
  let travelled = 0;
  let stopped = false;
  let erupted = false;
  const endpoint = {
    kind: 'circle' as const,
    x: route.endX,
    y: route.endY,
    radiusFt: eruptionRadius,
  };
  const travelGeometry = (sweptLane: MobAbilityLaneGeometry): MobAbilityGeometry =>
    mode === 'burrow' ? { kind: 'composite', shapes: [sweptLane, endpoint] } : sweptLane;
  activateMobAbilityRecovery(world, {
    abilityId: ctx.abilityId,
    casterEid: ctx.casterEid,
    sourceId: ctx.sourceId,
    durationMs: duration + GAME.DELTA_MS,
  });
  registerMobAbilityOwnedZone(world, {
    abilityId: ctx.abilityId,
    casterEid: ctx.casterEid,
    sourceId: ctx.sourceId,
    geometry: travelGeometry(route),
    durationMs: duration,
    tickIntervalMs: GAME.DELTA_MS,
    sampleGeometry: (elapsed) =>
      travelGeometry(
        lane(
          route.originX + route.dirX * travelled,
          route.originY + route.dirY * travelled,
          route.dirX,
          route.dirY,
          stopped ? 0 : Math.max(0, (route.lengthFt * elapsed) / duration - travelled),
          route.widthFt,
        ),
      ),
    tick: (zoneWorld, zone) => {
      const step = stopped
        ? 0
        : Math.max(0, route.lengthFt * Math.min(zone.elapsedMs / duration, 1) - travelled);
      const x = route.originX + route.dirX * travelled;
      const y = route.originY + route.dirY * travelled;
      const safe = safeDistance(zoneWorld, ctx.casterEid, x, y, route.dirX, route.dirY, step);
      stopped ||= safe + 1e-6 < step;
      zone.geometry = travelGeometry(lane(x, y, route.dirX, route.dirY, safe, route.widthFt));
      travelled += safe;
      zoneWorld.stores.position.x[ctx.casterEid] = route.originX + route.dirX * travelled;
      zoneWorld.stores.position.y[ctx.casterEid] = route.originY + route.dirY * travelled;
      zoneWorld.stores.velocity.x[ctx.casterEid] = 0;
      zoneWorld.stores.velocity.y[ctx.casterEid] = 0;
      if (hasComponent(zoneWorld.ecs, ctx.casterEid, Knockback))
        removeComponent(zoneWorld.ecs, ctx.casterEid, Knockback);
      if (mode !== 'burrow')
        hit(
          zoneWorld,
          ctx,
          zone.geometry,
          20,
          (eid) => {
            if (mode === 'cart') knockback(zoneWorld, eid, route.dirX, route.dirY);
            else recoverStolenGoldAt(zoneWorld, route.endX, route.endY, maxGold);
          },
          hits,
        );
      // A newly inserted wall can abort travel, but must never relocate the
      // committed endpoint eruption onto an untelegraphed position.
      if (mode === 'burrow' && !stopped && !erupted && zone.elapsedMs + 1e-6 >= duration) {
        erupted = true;
        const cx = zoneWorld.stores.position.x[ctx.casterEid]!;
        const cy = zoneWorld.stores.position.y[ctx.casterEid]!;
        const circle = { kind: 'circle' as const, x: cx, y: cy, radiusFt: eruptionRadius };
        // The durable burst survives this zone's end-of-frame removal; active
        // geometry retains the endpoint warning until the actual eruption.
        pushMobAbilityBurst(zoneWorld.mobAbilities.pendingBursts, {
          kind: 'resolution',
          abilityId: ctx.abilityId,
          geometry: circle,
        });
        hit(zoneWorld, ctx, circle, 20, (eid) =>
          knockback(
            zoneWorld,
            eid,
            zoneWorld.stores.position.x[eid]! - cx,
            zoneWorld.stores.position.y[eid]! - cy,
          ),
        );
      }
    },
  });
}

export function createScrapCartStampedeDefinition(): MobAbilityRuntimeDefinition {
  const ability = catalog('nana-snaggle-scrap-cart-stampede');
  const width = numberValue(ability, 'width', 'feet', true);
  requireValue(ability, 'length-mode', 'to-wall-or-arena-edge', true);
  requireValue(ability, 'damage-profile', 'moderate');
  requireValue(ability, 'knockback-profile', 'strong');
  return {
    ...base(ability),
    geometry: { kind: 'lane', widthFt: width, maxRangeFt: 64 },
    commitGeometry: ({ world, casterEid, lockedX, lockedY }) =>
      commitLane(world, casterEid, lockedX, lockedY, width, extent(world), false),
    resolve: (world, ctx) => {
      if (ctx.geometry.kind === 'lane') resolveTravel(world, ctx, ctx.geometry, 'cart');
    },
  };
}

export function createUndermineUnionDefinition(): MobAbilityRuntimeDefinition {
  const ability = catalog('foreman-grubbs-undermine-the-union');
  const width = numberValue(ability, 'lane-width', 'feet', true);
  const radius = numberValue(ability, 'endpoint-radius', 'feet', true);
  const range = numberValue(ability, 'max-range', 'feet', true);
  requireValue(ability, 'damage-profile', 'moderate');
  requireValue(ability, 'knockback-profile', 'strong-outward');
  return {
    ...base(ability),
    geometry: { kind: 'lane', widthFt: width, maxRangeFt: range },
    commitGeometry: ({ world, casterEid, lockedX, lockedY }) => {
      const route = commitLane(world, casterEid, lockedX, lockedY, width, range, true);
      return {
        kind: 'composite',
        shapes: [route, { kind: 'circle', x: route.endX, y: route.endY, radiusFt: radius }],
      };
    },
    resolve: (world, ctx) => {
      const route =
        ctx.geometry.kind === 'composite'
          ? ctx.geometry.shapes.find((shape) => shape.kind === 'lane')
          : undefined;
      if (route?.kind === 'lane') resolveTravel(world, ctx, route, 'burrow', 0, radius);
    },
  };
}

export function createHighwayRobberyDefinition(): MobAbilityRuntimeDefinition {
  const ability = catalog('boss-bandit-rocco-highway-robbery');
  const width = numberValue(ability, 'width', 'feet', true);
  const range = numberValue(ability, 'max-range', 'feet', true);
  const gold = numberValue(ability, 'max-stolen-gold', 'count');
  requireValue(ability, 'stolen-gold-recoverable', true);
  requireValue(ability, 'damage-profile', 'moderate');
  return {
    ...base(ability),
    geometry: { kind: 'lane', widthFt: width, maxRangeFt: range },
    commitGeometry: ({ world, casterEid, lockedX, lockedY }) =>
      commitLane(world, casterEid, lockedX, lockedY, width, range, false),
    resolve: (world, ctx) => {
      if (ctx.geometry.kind === 'lane') resolveTravel(world, ctx, ctx.geometry, 'robbery', gold);
    },
  };
}

export function createHellfireShiftLineDefinition(): MobAbilityRuntimeDefinition {
  const ability = catalog('foreman-scorch-hellfire-shift-line');
  const width = numberValue(ability, 'width', 'feet', true);
  const duration = numberValue(ability, 'wall-duration', 'milliseconds');
  requireValue(ability, 'length-mode', 'full-arena', true);
  requireValue(ability, 'impact-damage-profile', 'moderate');
  requireValue(ability, 'wall-damage-profile', 'light-repeated');
  return {
    ...base(ability),
    geometry: { kind: 'lane', widthFt: width, maxRangeFt: 64 },
    commitGeometry: ({ world, casterEid, lockedX, lockedY }) => {
      const cx = world.stores.position.x[casterEid] ?? 0;
      const cy = world.stores.position.y[casterEid] ?? 0;
      const length = Math.hypot(lockedX - cx, lockedY - cy);
      const dx = length > 0.001 ? (lockedX - cx) / length : 1;
      const dy = length > 0.001 ? (lockedY - cy) / length : 0;
      const limit = extent(world);
      const ray = (sign: number): number => {
        if (!world.floorMap) return limit;
        let distance = 0;
        for (let step = PATH_STEP_FT; step <= limit; step += PATH_STEP_FT) {
          if (!world.floorMap.isPassableAt(lockedX + dx * step * sign, lockedY + dy * step * sign))
            break;
          distance = step;
        }
        return distance;
      };
      const behind = ray(-1);
      return lane(lockedX - dx * behind, lockedY - dy * behind, dx, dy, behind + ray(1), width);
    },
    resolve: (world, ctx) => {
      if (ctx.geometry.kind !== 'lane') return;
      hit(world, ctx, ctx.geometry, 20);
      registerMobAbilityOwnedZone(world, {
        abilityId: ctx.abilityId,
        casterEid: ctx.casterEid,
        sourceId: ctx.sourceId,
        geometry: ctx.geometry,
        durationMs: duration,
        tickIntervalMs: FIRE_TICK_MS,
        tick: (zoneWorld, zone) => hit(zoneWorld, ctx, zone.geometry, 10),
      });
    },
  };
}
