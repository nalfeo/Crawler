/**
 * Typed, mob-agnostic ability runtime — pure data + handler contracts.
 *
 * This is deliberately NOT a `designValues` interpreter/DSL. The catalog
 * (`src/shared/boss-abilities.ts`) describes ability *data*; a typed adapter
 * (see `verdigris-glamour.ts`) reads the known fields it needs into the strongly
 * typed {@link MobAbilityRuntimeDefinition} below, and provides a named
 * {@link MobAbilityResolveHandler} for that ability kind. The generic executor
 * (`runtime.ts`) drives the phase machine and calls the handler at resolution.
 *
 * Phaser-free: lives in `src/core` so it runs identically in the visual game,
 * the headless runner, and the combat arena lab. No `Date.now()`, no
 * `Math.random()` — timing is the fixed-step frame clock, randomness (if any)
 * must come from `world.rng`.
 */

import type { GameWorld } from '../world.js';

/** Internal phase of an in-flight ability cast (per caster). */
export type MobAbilityPhase = 'cooldown' | 'telegraph' | 'active';

/** Public cue phase surfaced to the renderer. */
export type MobAbilityCuePhase = 'telegraph' | 'outbound' | 'hold' | 'return';

/** Danger-cue colour, mirrored from the catalog. */
export type MobAbilityDangerColor = 'ability-theme' | 'hostile-red';

/**
 * Committed circle geometry, locked once at telegraph start. The renderer,
 * resolution logic, and any future avoidance code all consume THIS same public
 * value so they can never disagree about where the danger is.
 */
export interface MobAbilityCircleGeometry {
  readonly kind: 'circle';
  readonly x: number;
  readonly y: number;
  readonly radiusFt: number;
}

export interface MobAbilitySpawnCirclesGeometry {
  readonly kind: 'spawn-circles';
  readonly circles: readonly MobAbilityCircleGeometry[];
}

export interface MobAbilityLaneGeometry {
  readonly kind: 'lane';
  readonly originX: number;
  readonly originY: number;
  readonly endX: number;
  readonly endY: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly widthFt: number;
  readonly lengthFt: number;
}

/** Multi-circle geometry committed by a custom `commitGeometry` hook (e.g. Sovereign Cap triangle). */
export interface MobAbilityMultiCircleGeometry {
  readonly kind: 'multi-circle';
  readonly circles: readonly MobAbilityCircleGeometry[];
}

/**
 * Committed radial-projectiles geometry, locked once at telegraph start.
 * Describes twelve (or N) spoke paths radiating from the caster's position,
 * with a deterministic rotational offset derived from the cast ordinal.
 * The renderer draws spokes from casterX/casterY; the resolve handler launches
 * one projectile per spoke along the committed direction.
 */
export interface MobAbilityRadialProjectilesGeometry {
  readonly kind: 'radial-projectiles';
  /** World-space caster origin locked at telegraph start (feet). */
  readonly casterX: number;
  readonly casterY: number;
  /** Number of evenly-spaced spokes. */
  readonly count: number;
  /** Visual/danger length of each spoke (feet). */
  readonly spokeLengthFt: number;
  /**
   * Rotational offset applied to all spokes (degrees, 0..360). Derived
   * deterministically from the cast ordinal at telegraph-start time:
   * even ordinals → 0, odd ordinals → alternateOffsetDeg from the definition.
   */
  readonly offsetDeg: number;
}

export interface MobAbilityProjectileFanPath {
  readonly kind: 'projectile-path';
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
  readonly impactRadiusFt: number;
}

export interface MobAbilityProjectileFanGeometry {
  readonly kind: 'projectile-fan';
  readonly originX: number;
  readonly originY: number;
  readonly facingRad: number;
  readonly coneAngleDeg: number;
  readonly rangeFt: number;
  readonly paths: readonly MobAbilityProjectileFanPath[];
}

export type MobAbilityGeometry =
  | MobAbilityCircleGeometry
  | MobAbilitySpawnCirclesGeometry
  | MobAbilityLaneGeometry
  | MobAbilityMultiCircleGeometry
  | MobAbilityRadialProjectilesGeometry
  | MobAbilityProjectileFanGeometry;

export type MobAbilityTargetingMode = 'player-direction' | 'player-position' | 'self';
export type MobAbilityOriginMode = 'locked' | 'follows-caster';

export interface MobAbilitySelfBuffDefinition {
  readonly durationMs: number;
  readonly movementSpeedMultiplier: number;
  readonly meleeDamageMultiplier: number;
  /** Multiplier applied to realized knockback displacement (`< 1` = resistant). */
  readonly knockbackResistanceMultiplier: number;
  /** Visual-only active aura radius in feet (used by engine VFX). */
  readonly auraRadiusFt: number;
}

/**
 * A named handler that applies one ability's committed effect at resolution.
 * Handlers are ordinary typed functions (one per ability kind), never derived
 * from arbitrary catalog values.
 */
export type MobAbilityResolveHandler = (world: GameWorld, ctx: MobAbilityResolveContext) => void;

export interface MobAbilityReturningLaneEffectDefinition {
  readonly kind: 'returning-lane';
  readonly speedFtPerTick: number;
  readonly holdMs: number;
  readonly damageAmount: number;
}

/** Everything a resolve handler needs, all committed at telegraph start. */
export interface MobAbilityResolveContext {
  readonly abilityId: string;
  readonly casterEid: number;
  /** Stable per-cast source key for owned status effects (`mob-ability:<id>:<eid>`). */
  readonly sourceId: string;
  readonly geometry: MobAbilityGeometry;
  /** Target entity locked at telegraph start; `null`/invalid targets are tolerated. */
  readonly targetEid: number | null;
  /** Current living ability-owned entity count for this caster. */
  readonly countOwnedLiving?: () => number;
  /** Register one newly spawned ability-owned entity for lifecycle tracking. */
  readonly registerOwnedEntity?: (eid: number) => void;
}

/**
 * A fully typed runtime ability definition. Built by a per-ability adapter from
 * the catalog; consumed by the generic executor.
 */
export interface MobAbilityRuntimeDefinition {
  /** Catalog ability id, e.g. `queen-mab-verdigris-glamour`. */
  readonly abilityId: string;
  /** Appearance key that identifies the owning boss, e.g. `faerie-boss`. */
  readonly bossArchetypeKey: string;
  /** Positive ms before the first cast becomes eligible (from encounter start). */
  readonly firstEligibleAfterMs: number;
  /** Recurring cooldown ms, anchored AFTER each resolution. */
  readonly cooldownMs: number;
  /** Telegraph window ms between lock and resolution. */
  readonly telegraphDurationMs: number;
  /** Telegraph danger colour. */
  readonly dangerColor: MobAbilityDangerColor;
  /** Exact, fully formatted announcement string emitted once per cast. */
  readonly announcementText: string;
  /** Committed geometry footprint authored by this ability. */
  readonly geometry:
    | { readonly kind: 'circle'; readonly radiusFt: number }
    | { readonly kind: 'lane'; readonly widthFt: number; readonly maxRangeFt: number }
    | {
        readonly kind: 'lane';
        readonly widthFt: number;
        readonly maxRangeFt: number;
      }
    | {
        readonly kind: 'spawn-circles';
        readonly count: number;
        readonly radiusFt: number;
        readonly distanceFromCasterFt: number;
      }
    | {
        readonly kind: 'radial-projectiles';
        /** Number of evenly-spaced spokes (e.g. 12). */
        readonly count: number;
        /** Visual/danger length of each spoke used for telegraph rendering (feet). */
        readonly spokeLengthFt: number;
        /**
         * Degrees to rotate the spoke pattern on every other cast.
         * Cast ordinal 0, 2, 4… → 0°; ordinal 1, 3, 5… → this value.
         * Must be in (0, 360). Derived deterministically from `resolvedCasts` at
         * telegraph-start; never uses `Math.random()` or wall-clock time.
         */
        readonly alternateOffsetDeg: number;
      }
    | {
        readonly kind: 'projectile-fan';
        readonly count: number;
        readonly coneAngleDeg: number;
        readonly rangeFt: number;
        readonly impactRadiusFt: number;
      };
  /** Optional custom geometry commit from a locked origin position (e.g. triangle around player). */
  readonly commitGeometry?: (ctx: {
    readonly world: GameWorld;
    readonly casterEid: number;
    readonly targetEid: number | null;
    readonly lockedX: number;
    readonly lockedY: number;
  }) => MobAbilityGeometry;
  /** Targeting mode for telegraph lock semantics (player-position or self). */
  readonly targetingMode?: MobAbilityTargetingMode;
  /** Origin lock mode for telegraph geometry. */
  readonly originMode?: MobAbilityOriginMode;
  /** When true, telegraph frames pin caster velocity to zero. */
  readonly lockCasterDuringTelegraph?: boolean;
  /** Optional self-buff payload consumed by runtime helper seams. */
  readonly selfBuff?: MobAbilitySelfBuffDefinition;
  /** Optional active projectile/effect lifecycle driven after telegraph resolution. */
  readonly activeEffect?: MobAbilityReturningLaneEffectDefinition;
  /** Named typed effect handler run at resolution. */
  readonly resolve: MobAbilityResolveHandler;
}

/**
 * Committed public cue state, rebuilt each tick by the executor and consumed by
 * the renderer AND AI avoidance logic. The same committed geometry that the
 * renderer draws is the geometry the AI reads — guaranteeing no information
 * advantage. Ability resolution reads its geometry directly off the instance
 * (not from cues) to avoid any timing dependency on cue ordering.
 */
export interface MobAbilityCue {
  readonly abilityId: string;
  readonly casterEid: number;
  readonly phase: MobAbilityCuePhase;
  /** Telegraph fill progress in `[0, 1]` (0 at lock, 1 at resolution). */
  readonly telegraphProgress: number;
  readonly geometry: MobAbilityGeometry;
  readonly dangerColor: MobAbilityDangerColor;
  readonly announcementText: string;
  readonly projectileX?: number;
  readonly projectileY?: number;
}

export interface MobAbilityReturningLaneActiveState {
  readonly kind: 'returning-lane';
  readonly speedFtPerTick: number;
  readonly holdMs: number;
  readonly damageAmount: number;
  phase: 'outbound' | 'hold' | 'return';
  projectileX: number;
  projectileY: number;
  holdRemainingMs: number;
  readonly hitKeys: Set<string>;
}

export type MobAbilityActiveState = MobAbilityReturningLaneActiveState;

export type MobAbilityBurstEvent =
  | {
      readonly kind: 'resolution';
      readonly abilityId: string;
      readonly geometry: MobAbilityGeometry;
    }
  | {
      readonly kind: 'recatch';
      readonly x: number;
      readonly y: number;
    };

/** Per-caster runtime instance state driven by the executor. */
export interface MobAbilityInstanceState {
  readonly definition: MobAbilityRuntimeDefinition;
  phase: MobAbilityPhase;
  /** Remaining ms in the current phase. */
  timerMs: number;
  /** Geometry committed at telegraph start; `null` during cooldown. */
  committedGeometry: MobAbilityGeometry | null;
  /** Target eid committed at telegraph start; `null` during cooldown. */
  committedTargetEid: number | null;
  /**
   * Render-generation of the target committed at telegraph start. Compared at
   * resolution so same-Player-tag EID reuse cannot inherit a stale lock.
   */
  committedTargetGeneration: number | null;
  /** Count of fully resolved casts (telemetry / test observation). */
  resolvedCasts: number;
  /** Count of announcements emitted (must equal `resolvedCasts + inFlight`). */
  announcementsEmitted: number;
  /**
   * Per-registration generation token. Monotonically increases with each
   * `registerMobAbility` call. The runtime validates this against
   * `MobAbilityRuntime.registrationTokens` so that if an EID is recycled and a
   * new entity of the SAME archetype key is assigned the same slot, the stale
   * instance's token no longer matches — preventing false-positive liveness.
   */
  registrationToken: number;
  /** Optional in-flight active effect after telegraph resolution. */
  activeState: MobAbilityActiveState | null;
  /** Owned summoned entities for this caster's ability instance (eid -> generation). */
  readonly ownedEntityGenerations: Map<number, number>;
}

/**
 * Root runtime state stored on the world. Default OFF: an empty, disabled
 * runtime is the production default so the real game registers no active
 * definitions and emits zero casts/events.
 */
export interface MobAbilityRuntime {
  /**
   * Explicit feature gate. The real game leaves this `false`; only the combat
   * arena lab (and future explicit production activation) sets it `true`.
   */
  enabled: boolean;
  /**
   * Whether the encounter is explicitly active. Ability clocks only advance
   * while this is `true`; it is set at the arena `encounter.started` transition,
   * never at initialization/spawn.
   */
  encounterActive: boolean;
  /** Registered per-caster ability instances. Empty in production. */
  readonly byEntity: Map<number, MobAbilityInstanceState>;
  /** Committed public cue state for the renderer and AI avoidance, rebuilt each tick. */
  readonly cues: MobAbilityCue[];
  /**
   * Durable pending-burst queue populated by the executor when a cast resolves.
   * The VFX renderer drains this each frame to fire the resolution burst even if
   * the caster died in the same simulation step that called `clearMobAbility`
   * (which would remove the caster from `byEntity` before `PhaserBridge.sync`).
   */
  readonly pendingBursts: Array<MobAbilityBurstEvent>;
  /** Active self-buffs authored by ability handlers and ticked by the runtime. */
  readonly activeBuffsByEntity: Map<number, MobAbilityActiveBuffState>;
  /** Active recovery windows that temporarily suppress caster movement/attacks. */
  readonly recoveriesByEntity: Map<number, MobAbilityRecoveryState>;
  /** In-flight ability projectiles authored by typed handlers and ticked by the runtime. */
  readonly activeProjectiles: MobAbilityActiveProjectileState[];
  /** Persistent ability zones authored by typed handlers and ticked by the runtime. */
  readonly activeZones: MobAbilityActiveZoneState[];
  /** Runtime-owned persistent zones (e.g. Sovereign Cap toxic clouds). */
  readonly ownedZones: MobAbilityOwnedZone[];
  /**
   * Per-EID generation token, set on each `registerMobAbility` and cleared on
   * `clearMobAbility`. Compared against `MobAbilityInstanceState.registrationToken`
   * in `isCasterValid` to catch same-archetype EID recycling within a tick.
   */
  readonly registrationTokens: Map<number, number>;
  /** Monotonically increasing counter; incremented on each registration. */
  nextToken: number;
  /** Monotonically increasing persistent-zone id counter. */
  nextZoneId: number;
}

export interface MobAbilityActiveBuffState {
  readonly abilityId: string;
  readonly sourceId: string;
  readonly movementSpeedMultiplier: number;
  readonly meleeDamageMultiplier: number;
  readonly knockbackResistanceMultiplier: number;
  readonly auraRadiusFt: number;
  remainingMs: number;
}

export interface MobAbilityActiveProjectileState {
  readonly abilityId: string;
  readonly casterEid: number;
  readonly sourceId: string;
  readonly path: MobAbilityProjectileFanPath;
  readonly damageAmount: number;
  readonly zoneDurationMs: number;
  readonly slowMultiplier: number;
  readonly travelDurationMs: number;
  readonly onImpact: (world: GameWorld, projectile: MobAbilityActiveProjectileState) => void;
  elapsedMs: number;
}

export interface MobAbilityActiveZoneState {
  readonly abilityId: string;
  readonly casterEid: number;
  readonly sourceId: string;
  readonly circle: MobAbilityCircleGeometry;
  readonly slowMultiplier: number;
  remainingMs: number;
}

export type MobAbilityOwnedZoneTick = (world: GameWorld, zone: MobAbilityOwnedZone) => void;

export interface MobAbilityOwnedZone {
  readonly id: number;
  readonly abilityId: string;
  readonly casterEid: number;
  readonly sourceId: string;
  readonly geometry: MobAbilityGeometry;
  readonly durationMs: number;
  readonly tickIntervalMs: number;
  nextTickAtMs: number;
  elapsedMs: number;
  readonly tick: MobAbilityOwnedZoneTick;
}

export interface MobAbilityRecoveryState {
  readonly abilityId: string;
  readonly sourceId: string;
  remainingMs: number;
}

/** Create the default-off, empty runtime state for a fresh world. */
export function createMobAbilityRuntime(): MobAbilityRuntime {
  return {
    enabled: false,
    encounterActive: false,
    byEntity: new Map(),
    cues: [],
    pendingBursts: [],
    activeBuffsByEntity: new Map(),
    recoveriesByEntity: new Map(),
    activeProjectiles: [],
    activeZones: [],
    ownedZones: [],
    registrationTokens: new Map(),
    nextToken: 0,
    nextZoneId: 0,
  };
}

/** Stable per-cast source key for status effects owned by a caster's ability. */
export function mobAbilitySourceId(abilityId: string, casterEid: number): string {
  return `mob-ability:${abilityId}:${casterEid}`;
}

/**
 * Hard cap on `pendingBursts` — the VFX renderer drains quickly under normal
 * play but headless / lab runs have no renderer, so growth is capped
 * defensively (oldest dropped). Burst geometry data is cosmetic-only, so
 * dropping events is harmless. Matches the VFX_EVENT_CAP pattern.
 */
const MOB_ABILITY_BURST_CAP = 256;

/**
 * Push a burst event, enforcing {@link MOB_ABILITY_BURST_CAP} (drops oldest
 * when full). Follows the same bounded-queue pattern as `pushVfxEvent` and
 * `pushAnnouncement`.
 */
export function pushMobAbilityBurst(
  bursts: MobAbilityBurstEvent[],
  event: MobAbilityBurstEvent,
): void {
  bursts.push(event);
  if (bursts.length > MOB_ABILITY_BURST_CAP) {
    bursts.splice(0, bursts.length - MOB_ABILITY_BURST_CAP);
  }
}

export function pushMobAbilityRecatch(bursts: MobAbilityBurstEvent[], x: number, y: number): void {
  bursts.push({ kind: 'recatch', x, y });
  if (bursts.length > MOB_ABILITY_BURST_CAP) {
    bursts.splice(0, bursts.length - MOB_ABILITY_BURST_CAP);
  }
}

export function circlesForMobAbilityGeometry(
  geometry: MobAbilityGeometry,
): readonly MobAbilityCircleGeometry[] {
  switch (geometry.kind) {
    case 'circle':
      return [geometry];
    case 'lane':
      return [];
    case 'spawn-circles':
    case 'multi-circle':
      return geometry.circles;
    case 'radial-projectiles':
      // Radial-projectile spokes are rendered as lines, not circles;
      // callers that draw spokes handle this geometry kind explicitly.
      return [];
    case 'projectile-fan':
      return geometry.paths.map((path) => ({
        kind: 'circle',
        x: path.endX,
        y: path.endY,
        radiusFt: path.impactRadiusFt,
      }));
  }
}

export function mobAbilityGeometryCircles(
  geometry: MobAbilityGeometry,
): readonly MobAbilityCircleGeometry[] {
  return circlesForMobAbilityGeometry(geometry);
}
