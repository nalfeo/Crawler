import { query } from 'bitecs';
import {
  FLOOR4_BOSS_ABILITY_CATALOG,
  formatBossAbilityAnnouncement,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import { ENEMY_PROJECTILE } from '../../shared/constants.js';
import { Player, Position, Health } from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { applyStatusEffect } from '../status-effects.js';
import { spawnEnemyProjectile } from '../spawners/projectiles.js';
import type { GameWorld } from '../world.js';
import { activateMobAbilitySelfBuff, registerMobAbilityOwnedZone } from './runtime.js';
import type {
  MobAbilityGeometry,
  MobAbilityResolveContext,
  MobAbilityResolveHandler,
  MobAbilityRuntimeDefinition,
} from './types.js';

function numberValue(ability: BossAbilityDef, id: string, effect = false): number {
  const values = effect ? ability.effect.designValues : ability.telegraph.metrics;
  const value = values.find((entry) => entry.id === id)?.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${ability.id} requires numeric ${id}`);
  }
  return value;
}

function inside(geometry: MobAbilityGeometry, x: number, y: number): boolean {
  switch (geometry.kind) {
    case 'circle':
      return Math.hypot(x - geometry.x, y - geometry.y) <= geometry.radiusFt;
    case 'multi-circle':
    case 'spawn-circles':
      return geometry.circles.some((circle) => inside(circle, x, y));
    case 'cone': {
      const dx = x - geometry.originX;
      const dy = y - geometry.originY;
      const angle = Math.atan2(dy, dx) - geometry.facingRad;
      return (
        Math.hypot(dx, dy) <= geometry.rangeFt &&
        Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) <=
          (geometry.angleDeg * Math.PI) / 360
      );
    }
    case 'contracting-annulus':
      return (
        Math.abs(Math.hypot(x - geometry.x, y - geometry.y) - geometry.endRadiusFt) <=
        geometry.ringWidthFt / 2
      );
    case 'lane': {
      const dx = x - geometry.originX;
      const dy = y - geometry.originY;
      const along = dx * geometry.dirX + dy * geometry.dirY;
      return (
        along >= 0 &&
        along <= geometry.lengthFt &&
        Math.abs(dx * geometry.dirY - dy * geometry.dirX) <= geometry.widthFt / 2
      );
    }
    default:
      return false;
  }
}

/** Movement samples the complete physical footprint; it never crosses a pillar. */
function moveSafely(world: GameWorld, eid: number, x: number, y: number): void {
  const fromX = world.stores.position.x[eid]!;
  const fromY = world.stores.position.y[eid]!;
  const dx = x - fromX;
  const dy = y - fromY;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.5));
  const radius = world.stores.size.radius[eid] || 1;
  for (let step = 1; step <= steps; step += 1) {
    const px = fromX + (dx * step) / steps;
    const py = fromY + (dy * step) / steps;
    if (
      world.floorMap &&
      [-radius, 0, radius].some((ox) =>
        [-radius, 0, radius].some((oy) => !world.floorMap!.isPassableAt(px + ox, py + oy)),
      )
    )
      break;
    world.stores.position.x[eid] = px;
    world.stores.position.y[eid] = py;
  }
}

function shove(world: GameWorld, eid: number, x: number, y: number, feet: number): void {
  const px = world.stores.position.x[eid]!;
  const py = world.stores.position.y[eid]!;
  const distance = Math.hypot(px - x, py - y);
  moveSafely(
    world,
    eid,
    px + (distance ? (px - x) / distance : 1) * feet,
    py + (distance ? (py - y) / distance : 0) * feet,
  );
}

function slow(
  world: GameWorld,
  eid: number,
  ctx: MobAbilityResolveContext,
  durationMs: number,
  value: number,
  stat: 'speed' | 'attackSpeed' = 'speed',
): void {
  applyStatusEffect(world, eid, {
    stat,
    op: 'multiply',
    value,
    durationMs,
    sourceType: 'ability',
    sourceId: ctx.sourceId,
    stackRule: { mode: 'refresh' },
  });
}

function hitPlayers(
  world: GameWorld,
  ctx: MobAbilityResolveContext,
  multiplier: number,
  afterHit?: (eid: number) => void,
): void {
  for (const eid of query(world.ecs, [Player, Position, Health])) {
    if (world.stores.health.current[eid]! <= 0) continue;
    const x = world.stores.position.x[eid]!;
    const y = world.stores.position.y[eid]!;
    if (!inside(ctx.geometry, x, y)) continue;
    if (multiplier > 0) {
      applyDamage(world, eid, world.stores.damage.amount[ctx.casterEid]! * multiplier, x, y, {
        origin: 'enemy',
        affinity: 'physical',
        scaleWithPrimary: false,
        canCrit: false,
        sourceEid: ctx.casterEid,
      });
    }
    if (world.stores.health.current[eid]! > 0) afterHit?.(eid);
  }
}

/** Typed adapters, not a catalog interpreter. Summon orchestration stays in the scenario. */
export function createFloor4HeadlinerAbilityDefinition(
  archetypeId: string,
  resolveSummons: MobAbilityResolveHandler,
): MobAbilityRuntimeDefinition {
  const ability = FLOOR4_BOSS_ABILITY_CATALOG.entries.find(
    (entry) => entry.bossArchetypeId === archetypeId,
  );
  if (!ability) throw new Error(`Missing Floor 4 Headliner ability: ${archetypeId}`);
  const base = {
    abilityId: ability.id,
    bossArchetypeKey: archetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
    originMode: ability.targeting.origin,
    lockCasterDuringTelegraph: ability.targeting.origin === 'locked',
  };
  switch (archetypeId) {
    case 'floor4-bellhop-brawler':
      return {
        ...base,
        geometry: { kind: 'circle', radiusFt: numberValue(ability, 'radius') },
        resolve: (world, ctx) => {
          if (ctx.geometry.kind !== 'circle') return;
          const { x, y } = ctx.geometry;
          hitPlayers(world, ctx, 1, (eid) => shove(world, eid, x, y, 2));
        },
      };
    case 'floor4-mascot-mauler':
      return {
        ...base,
        geometry: { kind: 'circle', radiusFt: numberValue(ability, 'range') },
        commitGeometry: ({ world, casterEid, lockedX, lockedY }) => ({
          kind: 'cone',
          originX: world.stores.position.x[casterEid]!,
          originY: world.stores.position.y[casterEid]!,
          facingRad: Math.atan2(
            lockedY - world.stores.position.y[casterEid]!,
            lockedX - world.stores.position.x[casterEid]!,
          ),
          angleDeg: numberValue(ability, 'angle'),
          rangeFt: numberValue(ability, 'range'),
        }),
        resolve: (world, ctx) => {
          if (ctx.geometry.kind !== 'cone') return;
          const g = ctx.geometry;
          hitPlayers(world, ctx, 1.5, (eid) => shove(world, eid, g.originX, g.originY, 4));
          moveSafely(
            world,
            ctx.casterEid,
            g.originX + Math.cos(g.facingRad) * g.rangeFt,
            g.originY + Math.sin(g.facingRad) * g.rangeFt,
          );
        },
      };
    case 'floor4-pyro-principal':
      return {
        ...base,
        geometry: { kind: 'circle', radiusFt: numberValue(ability, 'radius') },
        commitGeometry: ({ lockedX, lockedY }) => {
          const radiusFt = numberValue(ability, 'radius');
          return {
            kind: 'multi-circle',
            circles: Array.from({ length: numberValue(ability, 'count') }, (_, i) => ({
              kind: 'circle',
              x: lockedX + Math.cos((i * Math.PI * 2) / 3) * radiusFt * 1.5,
              y: lockedY + Math.sin((i * Math.PI * 2) / 3) * radiusFt * 1.5,
              radiusFt,
            })),
          };
        },
        resolve: (world, ctx) => {
          hitPlayers(world, ctx, 1);
          registerMobAbilityOwnedZone(world, {
            abilityId: ctx.abilityId,
            casterEid: ctx.casterEid,
            sourceId: ctx.sourceId,
            geometry: ctx.geometry,
            durationMs: numberValue(ability, 'hazard-duration', true),
            tickIntervalMs: 500,
            tick: (zoneWorld, zone) =>
              hitPlayers(zoneWorld, { ...ctx, geometry: zone.geometry }, 0.25),
          });
        },
      };
    case 'floor4-stunt-captain':
      return {
        ...base,
        geometry: { kind: 'circle', radiusFt: numberValue(ability, 'start-radius') },
        commitGeometry: ({ lockedX, lockedY }) => ({
          kind: 'contracting-annulus',
          x: lockedX,
          y: lockedY,
          startRadiusFt: numberValue(ability, 'start-radius'),
          endRadiusFt: numberValue(ability, 'end-radius'),
          ringWidthFt: numberValue(ability, 'ring-width'),
        }),
        resolve: (world, ctx) => {
          if (ctx.geometry.kind !== 'contracting-annulus') return;
          const g = ctx.geometry;
          hitPlayers(world, ctx, 1.5);
          for (const eid of query(world.ecs, [Player, Position, Health])) {
            if (
              world.stores.health.current[eid]! > 0 &&
              Math.hypot(world.stores.position.x[eid]! - g.x, world.stores.position.y[eid]! - g.y) <
                g.endRadiusFt - g.ringWidthFt / 2
            )
              shove(world, eid, g.x, g.y, 4);
          }
          // A landing may cross space, but never land inside a solid footprint.
          const radius = world.stores.size.radius[ctx.casterEid] || 1;
          if (
            !world.floorMap ||
            [-radius, 0, radius].every((ox) =>
              [-radius, 0, radius].every((oy) => world.floorMap!.isPassableAt(g.x + ox, g.y + oy)),
            )
          ) {
            world.stores.position.x[ctx.casterEid] = g.x;
            world.stores.position.y[ctx.casterEid] = g.y;
          }
        },
      };
    case 'floor4-ringmaster-proxy':
      return {
        ...base,
        targetingMode: 'self',
        geometry: { kind: 'circle', radiusFt: numberValue(ability, 'radius') },
        resolve: (world, ctx) =>
          hitPlayers(world, ctx, 0, (eid) => {
            const duration = numberValue(ability, 'duration', true);
            slow(
              world,
              eid,
              ctx,
              duration,
              1 + numberValue(ability, 'movement-speed-modifier', true) / 100,
            );
            slow(
              world,
              eid,
              ctx,
              duration,
              1 + numberValue(ability, 'attack-speed-modifier', true) / 100,
              'attackSpeed',
            );
          }),
      };
    case 'floor4-camera-kraken':
      return {
        ...base,
        geometry: {
          kind: 'radial-projectiles',
          count: numberValue(ability, 'projectile-count'),
          spokeLengthFt: 28,
          alternateOffsetDeg: 0,
        },
        resolve: (world, ctx) => {
          if (ctx.geometry.kind !== 'radial-projectiles') return;
          const g = ctx.geometry;
          for (let i = 0; i < g.count; i += 1) {
            const angle = (i * Math.PI * 2) / g.count;
            ctx.registerOwnedEntity?.(
              spawnEnemyProjectile(
                world,
                g.casterX,
                g.casterY,
                Math.cos(angle) * ENEMY_PROJECTILE.SPEED,
                Math.sin(angle) * ENEMY_PROJECTILE.SPEED,
                world.stores.damage.amount[ctx.casterEid]!,
                ctx.casterEid,
                undefined,
                g.spokeLengthFt,
              ),
            );
          }
        },
      };
    case 'floor4-sponsor-sentinel':
      return {
        ...base,
        targetingMode: 'self',
        geometry: { kind: 'circle', radiusFt: numberValue(ability, 'radius') },
        resolve: (world, ctx) =>
          activateMobAbilitySelfBuff(world, {
            abilityId: ctx.abilityId,
            casterEid: ctx.casterEid,
            sourceId: ctx.sourceId,
            durationMs: numberValue(ability, 'duration', true),
            movementSpeedMultiplier: 1,
            meleeDamageMultiplier: 1,
            knockbackResistanceMultiplier: 0.65,
            damageTakenMultiplier: 1 - numberValue(ability, 'damage-reduction', true) / 100,
            auraRadiusFt: numberValue(ability, 'radius'),
          }),
      };
    case 'floor4-contract-collector':
      return {
        ...base,
        geometry: { kind: 'circle', radiusFt: numberValue(ability, 'max-range') },
        commitGeometry: ({ world, casterEid, lockedX, lockedY }) => {
          const originX = world.stores.position.x[casterEid]!;
          const originY = world.stores.position.y[casterEid]!;
          const angle = Math.atan2(lockedY - originY, lockedX - originX);
          const dirX = Math.cos(angle),
            dirY = Math.sin(angle);
          const lengthFt = numberValue(ability, 'max-range');
          return {
            kind: 'lane',
            originX,
            originY,
            dirX,
            dirY,
            lengthFt,
            endX: originX + dirX * lengthFt,
            endY: originY + dirY * lengthFt,
            widthFt: numberValue(ability, 'width'),
          };
        },
        resolve: (world, ctx) =>
          hitPlayers(world, ctx, 1.5, (eid) =>
            slow(world, eid, ctx, numberValue(ability, 'slow-duration', true), 0.8),
          ),
      };
    case 'floor4-showrunner':
      return {
        ...base,
        targetingMode: 'self',
        cleanupOwnedEntities: true,
        geometry: { kind: 'circle', radiusFt: numberValue(ability, 'radius') },
        commitGeometry: ({ world, lockedX, lockedY }) => {
          const center = world.floorMap?.tileToWorld(
            Math.floor(world.floorMap.width / 2),
            Math.floor(world.floorMap.height / 2),
          );
          return {
            kind: 'spawn-circles',
            circles: Array.from({ length: numberValue(ability, 'count') }, (_, i) => ({
              kind: 'circle',
              x: (center?.x ?? lockedX) + Math.cos((i * Math.PI * 2) / 5) * 18,
              y: (center?.y ?? lockedY) + Math.sin((i * Math.PI * 2) / 5) * 18,
              radiusFt: numberValue(ability, 'radius'),
            })),
          };
        },
        resolve: resolveSummons,
      };
    default:
      throw new Error(`Unbound Floor 4 Headliner: ${archetypeId}`);
  }
}
