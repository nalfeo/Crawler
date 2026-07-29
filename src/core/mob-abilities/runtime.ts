/**
 * Generic mob-ability executor + registration API.
 *
 * Drives a deterministic per-caster phase machine
 * (`cooldown -> telegraph -> resolution -> cooldown`) for every registered
 * {@link MobAbilityRuntimeDefinition}, independent of which mob owns it. It
 * commits target/origin/geometry ONCE at telegraph start, emits the
 * announcement exactly once per cast, publishes committed cue state for the
 * renderer, and calls the ability's named resolve handler at resolution.
 *
 * Safety boundary: nothing happens unless the runtime is explicitly `enabled`
 * AND the encounter is explicitly active. The production game leaves both off
 * and registers no definitions, so it emits zero casts/events (verified by
 * test). Ability clocks only begin at the explicit encounter-active transition,
 * never at spawn/initialization.
 *
 * Cleanup: death, despawn, encounter disable, recycled ids, and invalid targets
 * all release the caster's instance, its cue, and any status effects it owns.
 */

import { entityExists, hasComponent, query, removeComponent, removeEntity } from 'bitecs';
import { GAME } from '../../shared/constants.js';
import { EnemyProjectile, Health, Knockback, Player, Position, Velocity } from '../components.js';
import { applyStatusEffect, clearStatusEffects } from '../status-effects.js';
import { pushAnnouncement } from '../../shared/announcement-events.js';
import type { GameWorld } from '../world.js';
import {
  mobAbilitySourceId,
  pushMobAbilityBurst,
  type MobAbilityActiveProjectileState,
  type MobAbilityActiveBuffState,
  type MobAbilityGeometry,
  type MobAbilityInstanceState,
  type MobAbilityOwnedZone,
  type MobAbilityProjectileFanPath,
  type MobAbilityRuntimeDefinition,
} from './types.js';

/** Duration the arena/HUD banner shows a cast announcement (ms). */
const ANNOUNCEMENT_DURATION_MS = 2200;

/**
 * Phase-boundary epsilon (ms). Phase timers are exact multiples of the fixed
 * step, so the intended trigger frame lands on `timerMs === 0`. Repeated
 * float subtraction can leave a sub-nanosecond positive residual there; this
 * epsilon absorbs it so the cast fires on the intended deterministic frame
 * (never a step early — a full step is ~16.7ms, far above epsilon). This is the
 * single "simulation-step boundary" allowance the spec calls out.
 */
const TIMER_EPSILON_MS = 1e-6;
const MIN_OWNED_ZONE_TICK_INTERVAL_MS = 1;

function normalizedTargetingMode(
  def: MobAbilityRuntimeDefinition,
): 'player-direction' | 'player-position' | 'self' {
  return def.targetingMode ?? 'player-position';
}

function normalizedOriginMode(def: MobAbilityRuntimeDefinition): 'locked' | 'follows-caster' {
  return def.originMode ?? 'locked';
}

/**
 * Register `definition` as an active ability owned by `casterEid`. Idempotent:
 * re-registering the same caster resets its clock to the first-eligibility
 * cooldown. Registration alone does nothing until the runtime is enabled and
 * the encounter is active.
 */
export function registerMobAbility(
  world: GameWorld,
  casterEid: number,
  definition: MobAbilityRuntimeDefinition,
): void {
  // Re-registering an eid first releases any prior instance's cue + owned
  // effects, so a recycled/re-used caster slot can never inherit stale
  // telegraph cues or lingering debuffs from a previous registration.
  if (world.mobAbilities.byEntity.has(casterEid)) {
    clearMobAbility(world, casterEid);
  }
  const token = world.mobAbilities.nextToken;
  world.mobAbilities.nextToken += 1;
  world.mobAbilities.registrationTokens.set(casterEid, token);
  world.mobAbilities.byEntity.set(casterEid, {
    definition,
    phase: 'cooldown',
    timerMs: definition.firstEligibleAfterMs,
    committedGeometry: null,
    committedTargetEid: null,
    committedTargetGeneration: null,
    resolvedCasts: 0,
    announcementsEmitted: 0,
    registrationToken: token,
    ownedEntityGenerations: new Map(),
  });
}

/**
 * Release every piece of state owned by a caster's ability: its instance, its
 * committed cue, and any status effects it applied to any entity. Used by the
 * cleanup paths (death/despawn/disable/recycled-id/invalid-target).
 */
export function clearMobAbility(world: GameWorld, casterEid: number): void {
  const runtime = world.mobAbilities;
  const inst = runtime.byEntity.get(casterEid);
  if (inst === undefined) return;
  clearOwnedProjectiles(world, inst);
  runtime.byEntity.delete(casterEid);
  runtime.registrationTokens.delete(casterEid);
  runtime.recoveriesByEntity.delete(casterEid);

  // Drop any committed cue for this caster.
  for (let i = runtime.cues.length - 1; i >= 0; i -= 1) {
    if (runtime.cues[i]!.casterEid === casterEid) runtime.cues.splice(i, 1);
  }

  // Retire cast announcements owned by this caster so canceled telegraphs do not
  // stay visible on the HUD banner.
  const announcementPrefix = `${mobAbilitySourceId(inst.definition.abilityId, casterEid)}:cast-`;
  for (let i = world.announcements.length - 1; i >= 0; i -= 1) {
    const event = world.announcements[i]!;
    if (event.kind !== 'bossAbilityCast') continue;
    if (event.eventId?.startsWith(announcementPrefix)) {
      world.announcements.splice(i, 1);
    }
  }

  // Release owned status effects (e.g. Tarnished) from every affected entity.
  const sourceId = mobAbilitySourceId(inst.definition.abilityId, casterEid);
  for (const eid of [...world.statusEffectsByEntity.keys()]) {
    clearStatusEffects(
      world,
      eid,
      (effect) => effect.sourceId === sourceId || effect.sourceId.startsWith(`${sourceId}:`),
    );
  }
  inst.ownedEntityGenerations.clear();
  world.mobAbilities.activeBuffsByEntity.delete(casterEid);
  for (let i = runtime.activeProjectiles.length - 1; i >= 0; i -= 1) {
    if (runtime.activeProjectiles[i]!.casterEid === casterEid) {
      runtime.activeProjectiles.splice(i, 1);
    }
  }
  for (let i = runtime.activeZones.length - 1; i >= 0; i -= 1) {
    if (runtime.activeZones[i]!.casterEid === casterEid) {
      runtime.activeZones.splice(i, 1);
    }
  }
  clearMobAbilityOwnedZones(
    world,
    (zone) =>
      zone.casterEid === casterEid ||
      zone.sourceId === sourceId ||
      zone.sourceId.startsWith(`${sourceId}:`),
  );
}

function clearOwnedProjectiles(world: GameWorld, inst: MobAbilityInstanceState): void {
  for (const [eid, generation] of inst.ownedEntityGenerations) {
    if (!entityExists(world.ecs, eid)) continue;
    if ((world.entityRenderGeneration[eid] ?? -1) !== generation) continue;
    if (!hasComponent(world.ecs, eid, EnemyProjectile)) continue;
    removeEntity(world.ecs, eid);
    world.enemyProjectileArchetypeKeys.delete(eid);
  }
}

/** Enable/disable the runtime feature gate. Disabling clears all cues + clocks. */
export function setMobAbilitiesEnabled(world: GameWorld, enabled: boolean): void {
  world.mobAbilities.enabled = enabled;
  if (!enabled) disableMobAbilityEncounter(world);
}

/**
 * Mark the encounter explicitly active and (re)anchor every registered ability's
 * first-eligibility clock. This is the ONLY place ability clocks begin — call it
 * at the arena `encounter.started` transition, never at spawn.
 */
export function activateMobAbilityEncounter(world: GameWorld): void {
  const runtime = world.mobAbilities;
  runtime.encounterActive = true;
  runtime.recoveriesByEntity.clear();
  runtime.activeProjectiles.length = 0;
  runtime.activeZones.length = 0;
  runtime.ownedZones.length = 0;
  for (const inst of runtime.byEntity.values()) {
    inst.phase = 'cooldown';
    inst.timerMs = inst.definition.firstEligibleAfterMs;
    inst.committedGeometry = null;
    inst.committedTargetEid = null;
    inst.committedTargetGeneration = null;
  }
}

/** Deactivate the encounter and release all in-flight cues + owned effects. */
export function disableMobAbilityEncounter(world: GameWorld): void {
  const runtime = world.mobAbilities;
  runtime.encounterActive = false;
  for (const casterEid of [...runtime.byEntity.keys()]) {
    clearMobAbility(world, casterEid);
  }
  runtime.cues.length = 0;
  // Clear the presentation burst queue on global encounter teardown. A
  // disable/scene-teardown that occurs after resolution but before
  // PhaserBridge.sync would otherwise render the old encounter's burst in the
  // new scene context, violating the encounter-disable cleanup contract.
  // Note: caster-local clearMobAbility intentionally does NOT clear
  // pendingBursts so that per-caster death still renders the resolution VFX.
  runtime.pendingBursts.length = 0;
  runtime.activeBuffsByEntity.clear();
  runtime.recoveriesByEntity.clear();
  runtime.activeProjectiles.length = 0;
  runtime.activeZones.length = 0;
  runtime.ownedZones.length = 0;
}

/** A caster is valid iff it still exists, is alive, and is still its own boss. */
function isCasterValid(world: GameWorld, eid: number, inst: MobAbilityInstanceState): boolean {
  if (!entityExists(world.ecs, eid)) return false;
  if (!hasComponent(world.ecs, eid, Health)) return false;
  if ((world.stores.health.current[eid] ?? 0) <= 0) return false;
  // Appearance-key guard: the slot must still carry the same boss archetype.
  if (world.enemyAppearanceKeys.get(eid) !== inst.definition.bossArchetypeKey) return false;
  // Generation-token guard: detect same-archetype EID recycling within a tick.
  // If a new entity of the same archetype reuses this EID before mobAbilitySystem
  // runs (e.g. Queen dies and a fresh faerie-boss spawns in the same tick), the
  // token in registrationTokens will have changed (new registration) or been
  // deleted (no re-registration) — either way it no longer matches inst.
  return world.mobAbilities.registrationTokens.get(eid) === inst.registrationToken;
}

/** Resolve the current target's live position, or `null` if it is gone. */
function targetPosition(
  world: GameWorld,
  targetEid: number | null,
): { x: number; y: number } | null {
  if (targetEid === null || !entityExists(world.ecs, targetEid)) return null;
  const x = world.stores.position.x[targetEid];
  const y = world.stores.position.y[targetEid];
  if (x === undefined || y === undefined) return null;
  return { x, y };
}

/**
 * A target is valid iff it still exists, is still the player, and has non-zero
 * health. This preserves target identity across the telegraph window: if the
 * locked player EID is recycled into any other health-bearing entity,
 * {@link resolveCast} takes the invalid-target cleanup path instead of resolving
 * against the wrong target. The existence/Health guards stay first so obviously
 * invalid or dead entities exit before the stricter Player-identity check.
 */
function isTargetValid(
  world: GameWorld,
  targetEid: number | null,
  targetGeneration: number | null,
): boolean {
  if (targetEid === null || !entityExists(world.ecs, targetEid)) return false;
  if (targetGeneration === null) return false;
  if ((world.entityRenderGeneration[targetEid] ?? 0) !== targetGeneration) return false;
  if (!hasComponent(world.ecs, targetEid, Health)) return false;
  if (!hasComponent(world.ecs, targetEid, Player)) return false;
  if ((world.stores.health.current[targetEid] ?? 0) <= 0) return false;
  return true;
}

function buildProjectileFanPaths(
  originX: number,
  originY: number,
  facingRad: number,
  count: number,
  coneAngleDeg: number,
  rangeFt: number,
  impactRadiusFt: number,
): MobAbilityProjectileFanPath[] {
  const halfAngleRad = (coneAngleDeg * Math.PI) / 360;
  const stepRad = count > 1 ? (halfAngleRad * 2) / (count - 1) : 0;
  const paths: MobAbilityProjectileFanPath[] = [];
  for (let i = 0; i < count; i += 1) {
    const angleRad = facingRad - halfAngleRad + stepRad * i;
    paths.push({
      kind: 'projectile-path',
      startX: originX,
      startY: originY,
      endX: originX + Math.cos(angleRad) * rangeFt,
      endY: originY + Math.sin(angleRad) * rangeFt,
      impactRadiusFt,
    });
  }
  return paths;
}

function beginTelegraph(world: GameWorld, casterEid: number, inst: MobAbilityInstanceState): void {
  const def = inst.definition;
  if (def.geometry.kind === 'projectile-fan') {
    const casterPos = targetPosition(world, casterEid);
    if (casterPos === null) {
      inst.phase = 'cooldown';
      inst.timerMs = def.cooldownMs;
      return;
    }
    const targetEid = findDefaultTarget(world);
    const targetPos = targetPosition(world, targetEid);
    if (targetPos === null) {
      inst.phase = 'cooldown';
      inst.timerMs = def.cooldownMs;
      return;
    }
    const facingRad = Math.atan2(targetPos.y - casterPos.y, targetPos.x - casterPos.x);
    inst.phase = 'telegraph';
    inst.timerMs = def.telegraphDurationMs;
    inst.committedTargetEid = targetEid;
    inst.committedTargetGeneration =
      targetEid === null ? null : (world.entityRenderGeneration[targetEid] ?? 0);
    inst.committedGeometry = {
      kind: 'projectile-fan',
      originX: casterPos.x,
      originY: casterPos.y,
      facingRad,
      coneAngleDeg: def.geometry.coneAngleDeg,
      rangeFt: def.geometry.rangeFt,
      paths: buildProjectileFanPaths(
        casterPos.x,
        casterPos.y,
        facingRad,
        def.geometry.count,
        def.geometry.coneAngleDeg,
        def.geometry.rangeFt,
        def.geometry.impactRadiusFt,
      ),
    };
  } else if (def.geometry.kind === 'spawn-circles') {
    const x = world.stores.position.x[casterEid];
    const y = world.stores.position.y[casterEid];
    if (x === undefined || y === undefined) {
      inst.phase = 'cooldown';
      inst.timerMs = def.cooldownMs;
      return;
    }
    const circles: Array<{ kind: 'circle'; x: number; y: number; radiusFt: number }> = [];
    for (let i = 0; i < def.geometry.count; i += 1) {
      const angle = (i / def.geometry.count) * Math.PI * 2;
      circles.push({
        kind: 'circle',
        x: x + Math.cos(angle) * def.geometry.distanceFromCasterFt,
        y: y + Math.sin(angle) * def.geometry.distanceFromCasterFt,
        radiusFt: def.geometry.radiusFt,
      });
    }
    inst.phase = 'telegraph';
    inst.timerMs = def.telegraphDurationMs;
    inst.committedTargetEid = null;
    inst.committedTargetGeneration = null;
    inst.committedGeometry = { kind: 'spawn-circles', circles };
  } else if (def.geometry.kind === 'radial-projectiles') {
    // Radial-projectile abilities lock caster position once at telegraph start
    // and derive the rotational offset from the cast ordinal (resolvedCasts).
    // No player target is needed — the geometry is purely caster-relative.
    const casterX = world.stores.position.x[casterEid];
    const casterY = world.stores.position.y[casterEid];
    if (casterX === undefined || casterY === undefined) {
      inst.phase = 'cooldown';
      inst.timerMs = def.cooldownMs;
      return;
    }
    // Alternating offset: even cast ordinals use 0°, odd ordinals use alternateOffsetDeg.
    // `inst.resolvedCasts` is the count of ALREADY resolved casts, so it equals the
    // 0-based ordinal of the UPCOMING cast (0 = first, 1 = second, …).
    const offsetDeg = inst.resolvedCasts % 2 === 0 ? 0 : def.geometry.alternateOffsetDeg;
    inst.phase = 'telegraph';
    inst.timerMs = def.telegraphDurationMs;
    inst.committedTargetEid = null;
    inst.committedTargetGeneration = null;
    inst.committedGeometry = {
      kind: 'radial-projectiles',
      casterX,
      casterY,
      count: def.geometry.count,
      spokeLengthFt: def.geometry.spokeLengthFt,
      offsetDeg,
    };
  } else {
    const targetingMode = normalizedTargetingMode(def);
    let targetEid: number | null;
    let pos: { x: number; y: number } | null = null;
    let casterPos: { x: number; y: number } | null = null;

    if (targetingMode === 'self') {
      targetEid = casterEid;
      pos = targetPosition(world, casterEid);
    } else {
      // Commit target + origin + geometry ONCE, now. Nothing tracks after this.
      targetEid = findDefaultTarget(world);
      if (targetEid !== null) {
        pos = targetPosition(world, targetEid);
      }
    }
    if (def.geometry.kind === 'lane') {
      casterPos = targetPosition(world, casterEid);
    }
    if (pos === null) {
      // No valid target/origin to lock onto — skip this cast and re-arm cooldown.
      inst.phase = 'cooldown';
      inst.timerMs = def.cooldownMs;
      return;
    }
    inst.phase = 'telegraph';
    inst.timerMs = def.telegraphDurationMs;
    inst.committedTargetEid = targetingMode === 'self' ? null : targetEid;
    inst.committedTargetGeneration =
      targetingMode === 'self' || targetEid === null
        ? null
        : (world.entityRenderGeneration[targetEid] ?? 0);
    if (def.geometry.kind === 'lane') {
      if (casterPos === null) {
        inst.phase = 'cooldown';
        inst.timerMs = def.cooldownMs;
        return;
      }
      const dx = pos.x - casterPos.x;
      const dy = pos.y - casterPos.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= Number.EPSILON) {
        inst.phase = 'cooldown';
        inst.timerMs = def.cooldownMs;
        return;
      }
      const dirX = dx / distance;
      const dirY = dy / distance;
      const lengthFt = Math.min(def.geometry.maxRangeFt, distance);
      inst.committedGeometry = {
        kind: 'lane',
        originX: casterPos.x,
        originY: casterPos.y,
        endX: casterPos.x + dirX * lengthFt,
        endY: casterPos.y + dirY * lengthFt,
        dirX,
        dirY,
        widthFt: def.geometry.widthFt,
        lengthFt,
      };
    } else {
      const committedGeometry = def.commitGeometry?.({
        world,
        casterEid,
        targetEid: targetingMode === 'self' ? null : targetEid,
        lockedX: pos.x,
        lockedY: pos.y,
      });
      if (committedGeometry !== undefined) {
        inst.committedGeometry = committedGeometry;
      } else if (def.geometry.kind === 'circle') {
        inst.committedGeometry = {
          kind: 'circle',
          x: pos.x,
          y: pos.y,
          radiusFt: def.geometry.radiusFt,
        };
      } else {
        inst.phase = 'cooldown';
        inst.timerMs = def.cooldownMs;
        return;
      }
    }
  }

  // Announcement is emitted exactly once, here, per cast.
  pushAnnouncement(world.announcements, {
    kind: 'bossAbilityCast',
    archetypeIndex: -1,
    text: def.announcementText,
    eventId: `${mobAbilitySourceId(def.abilityId, casterEid)}:cast-${inst.announcementsEmitted + 1}`,
    durationMs: ANNOUNCEMENT_DURATION_MS,
    elapsedMs: world.elapsedMs,
  });
  inst.announcementsEmitted += 1;
}

function tickActiveBuffs(world: GameWorld): void {
  const runtime = world.mobAbilities;
  const dtMs = GAME.DELTA_MS;
  for (const [eid, buff] of runtime.activeBuffsByEntity) {
    const next = buff.remainingMs - dtMs;
    if (next <= TIMER_EPSILON_MS) {
      runtime.activeBuffsByEntity.delete(eid);
      continue;
    }
    buff.remainingMs = next;
  }
}

function tickRecoveries(world: GameWorld): void {
  const runtime = world.mobAbilities;
  const dtMs = GAME.DELTA_MS;
  for (const [eid, recovery] of runtime.recoveriesByEntity) {
    const next = recovery.remainingMs - dtMs;
    if (next <= TIMER_EPSILON_MS) {
      runtime.recoveriesByEntity.delete(eid);
      continue;
    }
    recovery.remainingMs = next;
  }
}

export interface LaunchMobAbilityProjectilesInput {
  readonly abilityId: string;
  readonly casterEid: number;
  readonly sourceId: string;
  readonly paths: readonly MobAbilityProjectileFanPath[];
  readonly damageAmount: number;
  readonly zoneDurationMs: number;
  readonly slowMultiplier: number;
  readonly travelDurationMs: number;
  readonly onImpact: (world: GameWorld, projectile: MobAbilityActiveProjectileState) => void;
}

export function launchMobAbilityProjectiles(
  world: GameWorld,
  input: LaunchMobAbilityProjectilesInput,
): void {
  for (const path of input.paths) {
    world.mobAbilities.activeProjectiles.push({
      abilityId: input.abilityId,
      casterEid: input.casterEid,
      sourceId: input.sourceId,
      path,
      damageAmount: input.damageAmount,
      zoneDurationMs: input.zoneDurationMs,
      slowMultiplier: input.slowMultiplier,
      travelDurationMs: input.travelDurationMs,
      onImpact: input.onImpact,
      elapsedMs: 0,
    });
  }
}

export interface SpawnMobAbilityZoneInput {
  readonly abilityId: string;
  readonly casterEid: number;
  readonly sourceId: string;
  readonly x: number;
  readonly y: number;
  readonly radiusFt: number;
  readonly durationMs: number;
  readonly slowMultiplier: number;
}

export function spawnMobAbilityZone(world: GameWorld, zone: SpawnMobAbilityZoneInput): void {
  world.mobAbilities.activeZones.push({
    abilityId: zone.abilityId,
    casterEid: zone.casterEid,
    sourceId: zone.sourceId,
    circle: {
      kind: 'circle',
      x: zone.x,
      y: zone.y,
      radiusFt: zone.radiusFt,
    },
    remainingMs: zone.durationMs,
    slowMultiplier: zone.slowMultiplier,
  });
}

export function registerMobAbilityOwnedZone(
  world: GameWorld,
  zone: Omit<MobAbilityOwnedZone, 'id' | 'elapsedMs' | 'nextTickAtMs'>,
): number {
  if (
    !Number.isFinite(zone.tickIntervalMs) ||
    zone.tickIntervalMs < MIN_OWNED_ZONE_TICK_INTERVAL_MS
  ) {
    throw new Error(
      `Mob ability owned zone tickIntervalMs must be >= ${MIN_OWNED_ZONE_TICK_INTERVAL_MS} (received ${zone.tickIntervalMs})`,
    );
  }
  if (!Number.isFinite(zone.durationMs) || zone.durationMs <= 0) {
    throw new Error(`Mob ability owned zone durationMs must be > 0 (received ${zone.durationMs})`);
  }
  const id = world.mobAbilities.nextZoneId;
  world.mobAbilities.nextZoneId += 1;
  world.mobAbilities.ownedZones.push({
    ...zone,
    id,
    elapsedMs: 0,
    nextTickAtMs: zone.tickIntervalMs,
  });
  return id;
}

export function clearMobAbilityOwnedZones(
  world: GameWorld,
  predicate: (zone: MobAbilityOwnedZone) => boolean,
): void {
  const zones = world.mobAbilities.ownedZones;
  for (let i = zones.length - 1; i >= 0; i -= 1) {
    if (predicate(zones[i]!)) {
      zones.splice(i, 1);
    }
  }
}

function isPointInsideCircle(
  x: number,
  y: number,
  circle: { x: number; y: number; radiusFt: number },
): boolean {
  const dx = x - circle.x;
  const dy = y - circle.y;
  return dx * dx + dy * dy <= circle.radiusFt * circle.radiusFt;
}

function tickActiveProjectiles(world: GameWorld): void {
  const runtime = world.mobAbilities;
  const dtMs = GAME.DELTA_MS;
  for (let i = runtime.activeProjectiles.length - 1; i >= 0; i -= 1) {
    const projectile = runtime.activeProjectiles[i]!;
    projectile.elapsedMs += dtMs;
    if (projectile.elapsedMs + TIMER_EPSILON_MS < projectile.travelDurationMs) {
      continue;
    }
    projectile.onImpact(world, projectile);
    pushMobAbilityBurst(world.mobAbilities.pendingBursts, {
      abilityId: projectile.abilityId,
      geometry: {
        kind: 'circle',
        x: projectile.path.endX,
        y: projectile.path.endY,
        radiusFt: projectile.path.impactRadiusFt,
      },
    });
    runtime.activeProjectiles.splice(i, 1);
  }
}

function tickActiveZones(world: GameWorld): void {
  const runtime = world.mobAbilities;
  const dtMs = GAME.DELTA_MS;
  for (let i = runtime.activeZones.length - 1; i >= 0; i -= 1) {
    const zone = runtime.activeZones[i]!;
    zone.remainingMs -= dtMs;
    if (zone.remainingMs <= TIMER_EPSILON_MS) {
      runtime.activeZones.splice(i, 1);
    }
  }

  const players = query(world.ecs, [Player, Position, Health]);
  const activeZonePrefixes = new Set(
    runtime.activeZones.map((zone) => `mob-ability:${zone.abilityId}:`),
  );
  for (const player of players) {
    if ((world.stores.health.current[player] ?? 0) <= 0) continue;
    let slowSourceId: string | null = null;
    let slowMultiplier = 1;
    for (const zone of runtime.activeZones) {
      const x = world.stores.position.x[player] ?? 0;
      const y = world.stores.position.y[player] ?? 0;
      if (!isPointInsideCircle(x, y, zone.circle)) continue;
      if (slowSourceId === null || zone.slowMultiplier < slowMultiplier) {
        slowSourceId = zone.sourceId;
        slowMultiplier = zone.slowMultiplier;
      }
    }

    clearStatusEffects(
      world,
      player,
      (effect) =>
        effect.sourceType === 'ability' &&
        effect.stat === 'speed' &&
        effect.sourceId.endsWith(':slick') &&
        (activeZonePrefixes.size === 0 ||
          [...activeZonePrefixes].some((prefix) => effect.sourceId.startsWith(prefix))),
    );
    if (slowSourceId !== null) {
      applyStatusEffect(world, player, {
        stat: 'speed',
        op: 'multiply',
        value: slowMultiplier,
        durationMs: GAME.DELTA_MS * 2,
        sourceType: 'ability',
        sourceId: slowSourceId,
        stackRule: { mode: 'replace' },
      });
    }
  }
}

function tickOwnedZones(world: GameWorld): void {
  const dtMs = GAME.DELTA_MS;
  const zones = world.mobAbilities.ownedZones;
  for (let i = zones.length - 1; i >= 0; i -= 1) {
    const zone = zones[i]!;
    const inst = world.mobAbilities.byEntity.get(zone.casterEid);
    if (inst === undefined || !isCasterValid(world, zone.casterEid, inst)) {
      zones.splice(i, 1);
      continue;
    }
    zone.elapsedMs += dtMs;
    while (zone.elapsedMs + TIMER_EPSILON_MS >= zone.nextTickAtMs) {
      zone.tick(world, zone);
      zone.nextTickAtMs += zone.tickIntervalMs;
    }
    if (zone.elapsedMs + TIMER_EPSILON_MS >= zone.durationMs) {
      zones.splice(i, 1);
    }
  }
}

function syncTelegraphGeometryToCaster(
  world: GameWorld,
  casterEid: number,
  inst: MobAbilityInstanceState,
): void {
  if (inst.committedGeometry === null) return;
  if (inst.committedGeometry.kind !== 'circle' && inst.committedGeometry.kind !== 'lane') return;
  if (normalizedOriginMode(inst.definition) !== 'follows-caster') return;
  const pos = targetPosition(world, casterEid);
  if (pos === null) return;
  if (inst.committedGeometry.kind === 'circle') {
    inst.committedGeometry = {
      kind: 'circle',
      x: pos.x,
      y: pos.y,
      radiusFt: inst.committedGeometry.radiusFt,
    };
    return;
  }
  inst.committedGeometry = {
    ...inst.committedGeometry,
    originX: pos.x,
    originY: pos.y,
    endX: pos.x + inst.committedGeometry.dirX * inst.committedGeometry.lengthFt,
    endY: pos.y + inst.committedGeometry.dirY * inst.committedGeometry.lengthFt,
  };
}

function pinCasterDuringTelegraph(
  world: GameWorld,
  casterEid: number,
  inst: MobAbilityInstanceState,
): void {
  if (!inst.definition.lockCasterDuringTelegraph) return;
  if (!hasComponent(world.ecs, casterEid, Velocity)) return;
  world.stores.velocity.x[casterEid] = 0;
  world.stores.velocity.y[casterEid] = 0;
  if (hasComponent(world.ecs, casterEid, Knockback)) {
    removeComponent(world.ecs, casterEid, Knockback);
  }
}

function resolveCast(world: GameWorld, casterEid: number, inst: MobAbilityInstanceState): void {
  const def = inst.definition;
  const geometry = inst.committedGeometry;
  const countOwnedLiving = () => pruneOwnedEntities(world, inst);
  const registerOwnedEntity = (eid: number): void => {
    inst.ownedEntityGenerations.set(eid, world.entityRenderGeneration[eid] ?? 0);
  };
  const targetingMode = normalizedTargetingMode(def);
  const canResolve =
    def.geometry.kind === 'spawn-circles' ||
    def.geometry.kind === 'radial-projectiles' ||
    targetingMode === 'self' ||
    isTargetValid(world, inst.committedTargetEid, inst.committedTargetGeneration);
  // Revalidate the locked target before resolution. If the player died,
  // despawned, or its ID was recycled during the 1.5s telegraph, skip the
  // resolve call and take the cancellation/cleanup path instead.
  if (geometry !== null && canResolve) {
    def.resolve(world, {
      abilityId: def.abilityId,
      casterEid,
      sourceId: mobAbilitySourceId(def.abilityId, casterEid),
      geometry,
      targetEid: inst.committedTargetEid,
      countOwnedLiving,
      registerOwnedEntity,
    });
    inst.resolvedCasts += 1;
    // Enqueue a durable burst event so the VFX renderer can fire the resolution
    // burst even if the caster dies later in the same simulation step (which
    // would remove byEntity[casterEid] before PhaserBridge.sync runs).
    // Bounded push prevents unbounded headless growth (VFX is the sole drain).
    if (def.geometry.kind !== 'projectile-fan') {
      pushMobAbilityBurst(world.mobAbilities.pendingBursts, {
        abilityId: def.abilityId,
        geometry,
      });
    }
  }
  // Re-arm: cooldown is anchored AFTER resolution.
  inst.phase = 'cooldown';
  inst.timerMs = def.cooldownMs;
  inst.committedGeometry = null;
  inst.committedTargetEid = null;
  inst.committedTargetGeneration = null;
}

function pruneOwnedEntities(world: GameWorld, inst: MobAbilityInstanceState): number {
  for (const [eid, generation] of [...inst.ownedEntityGenerations.entries()]) {
    if (!entityExists(world.ecs, eid)) {
      inst.ownedEntityGenerations.delete(eid);
      continue;
    }
    if ((world.entityRenderGeneration[eid] ?? -1) !== generation) {
      inst.ownedEntityGenerations.delete(eid);
      continue;
    }
    if (hasComponent(world.ecs, eid, Health) && (world.stores.health.current[eid] ?? 0) <= 0) {
      inst.ownedEntityGenerations.delete(eid);
    }
  }
  return inst.ownedEntityGenerations.size;
}

export interface ActivateMobAbilitySelfBuffInput {
  readonly abilityId: string;
  readonly casterEid: number;
  readonly sourceId: string;
  readonly durationMs: number;
  readonly movementSpeedMultiplier: number;
  readonly meleeDamageMultiplier: number;
  readonly knockbackResistanceMultiplier: number;
  readonly auraRadiusFt: number;
}

/**
 * Activates one authoritative self-buff state for the caster.
 *
 * Non-stacking/non-extension contract: if the same ability buff is already
 * active on this caster, this call is a no-op.
 */
export function activateMobAbilitySelfBuff(
  world: GameWorld,
  buff: ActivateMobAbilitySelfBuffInput,
): void {
  const existing = world.mobAbilities.activeBuffsByEntity.get(buff.casterEid);
  if (
    existing &&
    existing.abilityId === buff.abilityId &&
    existing.remainingMs > TIMER_EPSILON_MS
  ) {
    return;
  }
  const state: MobAbilityActiveBuffState = {
    abilityId: buff.abilityId,
    sourceId: buff.sourceId,
    movementSpeedMultiplier: buff.movementSpeedMultiplier,
    meleeDamageMultiplier: buff.meleeDamageMultiplier,
    knockbackResistanceMultiplier: buff.knockbackResistanceMultiplier,
    auraRadiusFt: buff.auraRadiusFt,
    remainingMs: buff.durationMs,
  };
  world.mobAbilities.activeBuffsByEntity.set(buff.casterEid, state);
}

function activeBuff(world: GameWorld, eid: number): MobAbilityActiveBuffState | undefined {
  const buff = world.mobAbilities.activeBuffsByEntity.get(eid);
  if (buff === undefined) return undefined;
  if (buff.remainingMs <= TIMER_EPSILON_MS) {
    world.mobAbilities.activeBuffsByEntity.delete(eid);
    return undefined;
  }
  return buff;
}

export function getMobAbilityMovementSpeedMultiplier(world: GameWorld, eid: number): number {
  return activeBuff(world, eid)?.movementSpeedMultiplier ?? 1;
}

export function getMobAbilityMeleeDamageMultiplier(world: GameWorld, eid: number): number {
  return activeBuff(world, eid)?.meleeDamageMultiplier ?? 1;
}

export function getMobAbilityKnockbackResistanceMultiplier(world: GameWorld, eid: number): number {
  return activeBuff(world, eid)?.knockbackResistanceMultiplier ?? 1;
}

export function getMobAbilityActiveAura(world: GameWorld, eid: number): MobAbilityGeometry | null {
  const buff = activeBuff(world, eid);
  if (buff === undefined) return null;
  const pos = targetPosition(world, eid);
  if (pos === null) return null;
  return { kind: 'circle', x: pos.x, y: pos.y, radiusFt: buff.auraRadiusFt };
}

export interface ActivateMobAbilityRecoveryInput {
  readonly abilityId: string;
  readonly casterEid: number;
  readonly sourceId: string;
  readonly durationMs: number;
}

export function activateMobAbilityRecovery(
  world: GameWorld,
  recovery: ActivateMobAbilityRecoveryInput,
): void {
  if (!(Number.isFinite(recovery.durationMs) && recovery.durationMs > 0)) return;
  const existing = world.mobAbilities.recoveriesByEntity.get(recovery.casterEid);
  if (existing !== undefined && existing.abilityId === recovery.abilityId) {
    existing.remainingMs = Math.max(existing.remainingMs, recovery.durationMs);
    return;
  }
  world.mobAbilities.recoveriesByEntity.set(recovery.casterEid, {
    abilityId: recovery.abilityId,
    sourceId: recovery.sourceId,
    remainingMs: recovery.durationMs,
  });
}

export function getMobAbilityRecoveryRemainingMs(world: GameWorld, eid: number): number {
  const recovery = world.mobAbilities.recoveriesByEntity.get(eid);
  if (recovery === undefined) return 0;
  if (recovery.remainingMs <= TIMER_EPSILON_MS) {
    world.mobAbilities.recoveriesByEntity.delete(eid);
    return 0;
  }
  return recovery.remainingMs;
}

/** Default target selection: the living player singleton (catalog `player-position`). */
function findDefaultTarget(world: GameWorld): number | null {
  const players = query(world.ecs, [Player, Position]);
  for (const eid of players) {
    // A dead/invalid target must never anchor a telegraph — treat it as absent
    // so beginTelegraph takes the skip-and-re-arm path.
    if (!hasComponent(world.ecs, eid, Health)) continue;
    if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
    return eid;
  }
  return null;
}

/**
 * Advance every registered ability one fixed step. No-op unless the runtime is
 * enabled and the encounter is active; always leaves `cues` empty when idle so
 * the renderer never shows a stale telegraph.
 */
export function mobAbilitySystem(world: GameWorld): void {
  const runtime = world.mobAbilities;
  runtime.cues.length = 0;
  if (!runtime.enabled || !runtime.encounterActive) return;

  // Validate and clear invalid casters BEFORE ticking owned projectiles/zones.
  // A caster killed in the preceding frame must not fire onImpact or apply zone
  // effects on the next tick. clearMobAbility removes that caster's projectiles
  // and zones so tickActiveProjectiles/tickActiveZones only process live state.
  for (const casterEid of [...runtime.byEntity.keys()]) {
    const inst = runtime.byEntity.get(casterEid);
    if (inst !== undefined && !isCasterValid(world, casterEid, inst)) {
      clearMobAbility(world, casterEid);
    }
  }

  tickActiveBuffs(world);
  tickRecoveries(world);
  tickActiveProjectiles(world);
  tickActiveZones(world);

  // Tick pre-existing zones BEFORE processing new casts so that a zone
  // registered in resolveCast this step is not immediately advanced.
  // This keeps first-tick and expiry frame indices deterministic.
  tickOwnedZones(world);
  if (runtime.byEntity.size === 0) return;

  const dtMs = GAME.DELTA_MS;

  for (const casterEid of [...runtime.byEntity.keys()]) {
    const inst = runtime.byEntity.get(casterEid);
    if (inst === undefined) continue;

    // Caster validity was confirmed at frame start; run pruneOwnedEntities and
    // phase transitions. The isCasterValid guard remains here as a safety net
    // for edge cases introduced mid-loop by beginTelegraph/resolveCast.
    if (!isCasterValid(world, casterEid, inst)) {
      clearMobAbility(world, casterEid);
      continue;
    }
    pruneOwnedEntities(world, inst);

    inst.timerMs -= dtMs;
    if (inst.timerMs <= TIMER_EPSILON_MS) {
      if (inst.phase === 'cooldown') {
        beginTelegraph(world, casterEid, inst);
      } else {
        resolveCast(world, casterEid, inst);
      }
    }
    // Re-check after phase transitions so a cooldown→telegraph flip on this
    // same tick still gets pinned immediately (no one-frame movement leak).
    if (inst.phase === 'telegraph') {
      syncTelegraphGeometryToCaster(world, casterEid, inst);
      pinCasterDuringTelegraph(world, casterEid, inst);
    }

    // Publish committed cue state for the renderer (telegraph phase only).
    if (inst.phase === 'telegraph' && inst.committedGeometry !== null) {
      const progress = 1 - Math.max(0, inst.timerMs) / inst.definition.telegraphDurationMs;
      runtime.cues.push({
        abilityId: inst.definition.abilityId,
        casterEid,
        phase: 'telegraph',
        telegraphProgress: Math.min(1, Math.max(0, progress)),
        geometry: inst.committedGeometry,
        dangerColor: inst.definition.dangerColor,
        announcementText: inst.definition.announcementText,
      });
    }
  }
}
