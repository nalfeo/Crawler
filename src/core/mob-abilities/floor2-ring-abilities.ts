import { addComponent, hasComponent, query, set, setComponent } from 'bitecs';
import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import { GAME } from '../../shared/constants.js';
import { applyDamage } from '../apply-damage.js';
import { Health, Knockback, Player, Position } from '../components.js';
import { getBodyRadius } from '../physics-body.js';
import { applyStatusEffect } from '../status-effects.js';
import type { GameWorld } from '../world.js';
import { activateMobAbilityRecovery, registerMobAbilityOwnedZone } from './runtime.js';
import {
  pushMobAbilityBurst,
  type MobAbilityAnnulusGeometry,
  type MobAbilityResolveContext,
  type MobAbilityRuntimeDefinition,
  type MobAbilitySweepingArcGeometry,
} from './types.js';

const MODERATE_DAMAGE = 20;
const STRONG_KNOCKBACK_FT = 4;
const EPSILON = 1e-6;

function catalog(id: string): BossAbilityDef {
  const entry = getFloor2BossAbilityById(id);
  if (!entry) throw new Error(`Missing Floor 2 ring ability ${id}`);
  return entry;
}

function numberValue(entry: BossAbilityDef, id: string, unit: string, effect = false): number {
  const value = (effect ? entry.effect.designValues : entry.telegraph.metrics).find(
    (v) => v.id === id,
  );
  if (
    !value ||
    value.unit !== unit ||
    typeof value.value !== 'number' ||
    !Number.isFinite(value.value)
  ) {
    throw new Error(`${entry.id} requires numeric ${id} (${unit})`);
  }
  return value.value;
}

function moderateDamage(entry: BossAbilityDef): number {
  const profile = entry.effect.designValues.find((v) => v.id === 'damage-profile');
  if (profile?.value !== 'moderate')
    throw new Error(`${entry.id} requires moderate damage-profile`);
  return MODERATE_DAMAGE;
}

function base(entry: BossAbilityDef): Omit<MobAbilityRuntimeDefinition, 'geometry' | 'resolve'> {
  return {
    abilityId: entry.id,
    bossArchetypeKey: entry.bossArchetypeId,
    firstEligibleAfterMs: entry.timing.firstEligibleAfterMs,
    cooldownMs: entry.timing.cooldownMs,
    telegraphDurationMs: entry.telegraph.durationMs,
    dangerColor: entry.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(entry),
    originMode: 'locked',
    targetingMode: 'self',
    lockCasterDuringTelegraph: true,
  };
}

function ring(
  x: number,
  y: number,
  innerRadiusFt: number,
  outerRadiusFt: number,
): MobAbilityAnnulusGeometry {
  return { kind: 'annulus', x, y, innerRadiusFt, outerRadiusFt };
}

function overlaps(
  world: GameWorld,
  player: number,
  geometry: MobAbilityAnnulusGeometry | MobAbilitySweepingArcGeometry,
): boolean {
  const x = world.stores.position.x[player]!;
  const y = world.stores.position.y[player]!;
  const radius = getBodyRadius(world, player, 'floor2RingAbilities');
  if (geometry.kind === 'annulus') {
    const distance = Math.hypot(x - geometry.x, y - geometry.y);
    return (
      distance + radius >= geometry.innerRadiusFt && distance - radius <= geometry.outerRadiusFt
    );
  }
  // Distance to the solid sector: outside its angular span the closest feature
  // is one of its two radial edges, not an inflated all-direction disk.
  const dx = x - geometry.originX;
  const dy = y - geometry.originY;
  const delta = Math.atan2(
    Math.sin(Math.atan2(dy, dx) - geometry.facingRad),
    Math.cos(Math.atan2(dy, dx) - geometry.facingRad),
  );
  const half = (geometry.angleDeg * Math.PI) / 360;
  if (Math.abs(delta) <= half) return Math.hypot(dx, dy) <= geometry.rangeFt + radius;
  const nearest = geometry.facingRad + (delta < 0 ? -half : half);
  const nx = Math.cos(nearest);
  const ny = Math.sin(nearest);
  const along = Math.max(0, Math.min(geometry.rangeFt, dx * nx + dy * ny));
  return Math.hypot(dx - along * nx, dy - along * ny) <= radius;
}

function hitPlayers(
  world: GameWorld,
  ctx: MobAbilityResolveContext,
  geometry: MobAbilityAnnulusGeometry | MobAbilitySweepingArcGeometry,
  damage: number,
  afterHit?: (eid: number) => void,
  hitKeys?: Set<string>,
): void {
  for (const player of query(world.ecs, [Player, Position, Health])) {
    const key = `${player}:${world.entityRenderGeneration[player] ?? 0}`;
    if (
      world.stores.health.current[player]! <= 0 ||
      hitKeys?.has(key) ||
      !overlaps(world, player, geometry)
    )
      continue;
    const dealt = applyDamage(
      world,
      player,
      damage,
      world.stores.position.x[player]!,
      world.stores.position.y[player]!,
      {
        origin: 'enemy',
        affinity: 'physical',
        scaleWithPrimary: false,
        canCrit: false,
        sourceEid: ctx.casterEid,
        sourceX: geometry.kind === 'annulus' ? geometry.x : geometry.originX,
        sourceY: geometry.kind === 'annulus' ? geometry.y : geometry.originY,
      },
    );
    // One collision opportunity per moving cast, even if combat's dodge roll succeeds.
    hitKeys?.add(key);
    if (dealt > 0 && world.stores.health.current[player]! > 0) afterHit?.(player);
  }
}

function shoveOutward(
  world: GameWorld,
  player: number,
  x: number,
  y: number,
  distance: number,
): void {
  const dx = world.stores.position.x[player]! - x;
  const dy = world.stores.position.y[player]! - y;
  const length = Math.hypot(dx, dy);
  const value = {
    dirX: length > EPSILON ? dx / length : 1,
    dirY: length > EPSILON ? dy / length : 0,
    remaining: distance,
    speed: distance / 10,
  };
  if (hasComponent(world.ecs, player, Knockback)) setComponent(world.ecs, player, Knockback, value);
  else addComponent(world.ecs, player, set(Knockback, value));
}

export function createAbuelaThornRingDefinition(): MobAbilityRuntimeDefinition {
  const entry = catalog('abuela-saguaro-thorn-ring');
  const inner = numberValue(entry, 'inner-radius', 'feet');
  const outer = numberValue(entry, 'outer-radius', 'feet');
  const damage = moderateDamage(entry);
  return {
    ...base(entry),
    geometry: { kind: 'circle', radiusFt: outer },
    commitGeometry: ({ lockedX, lockedY }) => ring(lockedX, lockedY, inner, outer),
    resolve: (world, ctx) => {
      if (ctx.geometry.kind !== 'annulus') return;
      const geometry = ctx.geometry;
      hitPlayers(world, ctx, geometry, damage, (eid) =>
        shoveOutward(world, eid, geometry.x, geometry.y, STRONG_KNOCKBACK_FT),
      );
    },
  };
}

export function createMidnightResonanceDefinition(): MobAbilityRuntimeDefinition {
  const entry = catalog('countess-vesper-midnight-resonance');
  const count = numberValue(entry, 'band-count', 'count');
  const width = numberValue(entry, 'band-width', 'feet');
  const maxRadius = numberValue(entry, 'max-radius', 'feet');
  const interval = numberValue(entry, 'detonation-interval', 'milliseconds', true);
  const damage = moderateDamage(entry);
  if (count !== 3 || count * width !== maxRadius || interval <= 0)
    throw new Error('Invalid Midnight Resonance bands');
  return {
    ...base(entry),
    geometry: { kind: 'circle', radiusFt: maxRadius },
    commitGeometry: ({ lockedX, lockedY }) => ({
      kind: 'composite',
      orderedIntervalMs: interval,
      shapes: Array.from({ length: count }, (_, index) =>
        ring(lockedX, lockedY, index * width, (index + 1) * width),
      ),
    }),
    resolve: (world, ctx) => {
      if (ctx.geometry.kind !== 'composite') return;
      const bands = ctx.geometry.shapes.filter(
        (shape): shape is MobAbilityAnnulusGeometry => shape.kind === 'annulus',
      );
      if (bands.length !== count) return;
      const detonate = (targetWorld: GameWorld, band: MobAbilityAnnulusGeometry): void => {
        hitPlayers(targetWorld, ctx, band, damage, (eid) =>
          shoveOutward(targetWorld, eid, band.x, band.y, 2),
        );
        pushMobAbilityBurst(targetWorld.mobAbilities.pendingBursts, {
          kind: 'resolution',
          abilityId: entry.id,
          geometry: band,
        });
      };
      detonate(world, bands[0]!);
      registerMobAbilityOwnedZone(world, {
        abilityId: entry.id,
        casterEid: ctx.casterEid,
        sourceId: ctx.sourceId,
        geometry: bands[1]!,
        durationMs: interval * (count - 1),
        tickIntervalMs: interval,
        // Show the next imminent band after the preceding one has detonated.
        sampleGeometry: (elapsed) =>
          bands[Math.min(count - 1, Math.max(1, Math.ceil((elapsed - EPSILON) / interval)))]!,
        tick: (targetWorld, zone) =>
          detonate(targetWorld, bands[Math.round(zone.nextTickAtMs / interval)]!),
      });
    },
  };
}

export function createChitinTurnoverDefinition(): MobAbilityRuntimeDefinition {
  const entry = catalog('broodfather-chitin-turnover');
  const range = numberValue(entry, 'range', 'feet');
  const angle = numberValue(entry, 'arc-angle', 'degrees');
  const sweep = numberValue(entry, 'sweep-angle', 'degrees');
  const duration = numberValue(entry, 'sweep-duration', 'milliseconds', true);
  if (entry.effect.designValues.find((v) => v.id === 'direction-alternates')?.value !== true)
    throw new Error('Chitin Turnover must alternate');
  return {
    ...base(entry),
    targetingMode: 'player-direction',
    geometry: { kind: 'circle', radiusFt: range },
    commitGeometry: ({ world, casterEid, lockedX, lockedY }) => {
      const x = world.stores.position.x[casterEid]!;
      const y = world.stores.position.y[casterEid]!;
      return {
        kind: 'sweeping-arc',
        originX: x,
        originY: y,
        facingRad: Math.atan2(lockedY - y, lockedX - x),
        angleDeg: angle,
        rangeFt: range,
        sweepAngleDeg: sweep,
        direction: world.mobAbilities.byEntity.get(casterEid)!.resolvedCasts % 2 === 0 ? 1 : -1,
      };
    },
    resolve: (world, ctx) => {
      if (ctx.geometry.kind !== 'sweeping-arc') return;
      const geometry = ctx.geometry;
      const hitKeys = new Set<string>();
      const sampleGeometry = (elapsed: number): MobAbilitySweepingArcGeometry => ({
        ...geometry,
        facingRad:
          geometry.facingRad +
          (((geometry.direction * geometry.sweepAngleDeg * Math.PI) / 180) * elapsed) / duration,
      });
      // Reuse the runtime's movement lock while the committed sweep turns.
      activateMobAbilityRecovery(world, {
        abilityId: entry.id,
        casterEid: ctx.casterEid,
        sourceId: ctx.sourceId,
        durationMs: duration,
      });
      world.stores.velocity.x[ctx.casterEid] = 0;
      world.stores.velocity.y[ctx.casterEid] = 0;
      hitPlayers(world, ctx, geometry, MODERATE_DAMAGE, undefined, hitKeys);
      registerMobAbilityOwnedZone(world, {
        abilityId: entry.id,
        casterEid: ctx.casterEid,
        sourceId: ctx.sourceId,
        geometry,
        durationMs: duration,
        tickIntervalMs: GAME.DELTA_MS,
        sampleGeometry,
        tick: (targetWorld, zone) => {
          if (zone.geometry.kind === 'sweeping-arc')
            hitPlayers(targetWorld, ctx, zone.geometry, MODERATE_DAMAGE, undefined, hitKeys);
        },
      });
    },
  };
}

export function createLongSqueezeDefinition(): MobAbilityRuntimeDefinition {
  const entry = catalog('gastropod-godfather-long-squeeze');
  const start = numberValue(entry, 'start-radius', 'feet');
  const end = numberValue(entry, 'end-radius', 'feet');
  const width = numberValue(entry, 'ring-width', 'feet');
  const duration = numberValue(entry, 'contraction-duration', 'milliseconds', true);
  const slowDuration = numberValue(entry, 'slow-duration', 'milliseconds', true);
  const slow = 1 + numberValue(entry, 'movement-speed-modifier', 'percent', true) / 100;
  const damage = moderateDamage(entry);
  return {
    ...base(entry),
    geometry: { kind: 'circle', radiusFt: start },
    commitGeometry: ({ lockedX, lockedY }) => ({
      kind: 'contracting-annulus',
      x: lockedX,
      y: lockedY,
      startRadiusFt: start,
      endRadiusFt: end,
      ringWidthFt: width,
    }),
    resolve: (world, ctx) => {
      if (ctx.geometry.kind !== 'contracting-annulus') return;
      const geometry = ctx.geometry;
      const sampleGeometry = (elapsed: number): MobAbilityAnnulusGeometry => {
        const radius = start + ((end - start) * elapsed) / duration;
        return ring(geometry.x, geometry.y, Math.max(0, radius - width / 2), radius + width / 2);
      };
      const hitKeys = new Set<string>();
      const contact = (targetWorld: GameWorld, sampled: MobAbilityAnnulusGeometry): void => {
        hitPlayers(
          targetWorld,
          ctx,
          sampled,
          damage,
          (eid) =>
            applyStatusEffect(targetWorld, eid, {
              stat: 'speed',
              op: 'multiply',
              value: slow,
              durationMs: slowDuration,
              sourceType: 'ability',
              sourceId: ctx.sourceId,
              stackRule: { mode: 'replace' },
            }),
          hitKeys,
        );
      };
      const initial = sampleGeometry(0);
      contact(world, initial);
      registerMobAbilityOwnedZone(world, {
        abilityId: entry.id,
        casterEid: ctx.casterEid,
        sourceId: ctx.sourceId,
        geometry: initial,
        durationMs: duration,
        tickIntervalMs: GAME.DELTA_MS,
        sampleGeometry,
        tick: (targetWorld, zone) => {
          if (zone.geometry.kind === 'annulus') contact(targetWorld, zone.geometry);
        },
      });
    },
  };
}
