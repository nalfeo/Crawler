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

<<<<<<< HEAD
export interface MobAbilityLaneGeometry {
  readonly kind: 'lane';
  readonly originX: number;
  readonly originY: number;
  readonly endpointX: number;
  readonly endpointY: number;
  readonly widthFt: number;
  readonly lengthFt: number;
}

export type MobAbilityGeometry = MobAbilityCircleGeometry | MobAbilityLaneGeometry;
=======
export interface MobAbilitySpawnCirclesGeometry {
  readonly kind: 'spawn-circles';
  readonly circles: readonly MobAbilityCircleGeometry[];
}

export type MobAbilityGeometry = MobAbilityCircleGeometry | MobAbilitySpawnCirclesGeometry;
>>>>>>> origin/main

export type MobAbilityTargetingMode = 'player-position' | 'self';
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
<<<<<<< HEAD
  /** Committed geometry footprint (radius etc.); position is locked at cast. */
  readonly geometry:
    | { readonly kind: 'circle'; readonly radiusFt: number }
    | { readonly kind: 'lane'; readonly widthFt: number; readonly maxRangeFt: number };
=======
  /** Committed geometry footprint authored by this ability. */
  readonly geometry:
    | { readonly kind: 'circle'; readonly radiusFt: number }
    | {
        readonly kind: 'spawn-circles';
        readonly count: number;
        readonly radiusFt: number;
        readonly distanceFromCasterFt: number;
      };
>>>>>>> origin/main
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
  /** Owned summoned entities for this caster's ability instance (eid -> generation). */
  readonly ownedEntityGenerations: Map<number, number>;
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
<<<<<<< HEAD
  readonly pendingBursts: Array<MobAbilityBurstEvent>;
=======
  readonly pendingBursts: Array<MobAbilityBurst>;
>>>>>>> origin/main
  /** Active self-buffs authored by ability handlers and ticked by the runtime. */
  readonly activeBuffsByEntity: Map<number, MobAbilityActiveBuffState>;
  /**
   * Per-EID generation token, set on each `registerMobAbility` and cleared on
   * `clearMobAbility`. Compared against `MobAbilityInstanceState.registrationToken`
   * in `isCasterValid` to catch same-archetype EID recycling within a tick.
   */
  readonly registrationTokens: Map<number, number>;
  /** Monotonically increasing counter; incremented on each registration. */
  nextToken: number;
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

/** Create the default-off, empty runtime state for a fresh world. */
export function createMobAbilityRuntime(): MobAbilityRuntime {
  return {
    enabled: false,
    encounterActive: false,
    byEntity: new Map(),
    cues: [],
    pendingBursts: [],
    activeBuffsByEntity: new Map(),
    registrationTokens: new Map(),
    nextToken: 0,
  };
}

export interface MobAbilityBurst {
  readonly abilityId: string;
  readonly geometry: MobAbilityGeometry;
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
<<<<<<< HEAD
export function pushMobAbilityBurst(
  bursts: MobAbilityBurstEvent[],
  geom: MobAbilityGeometry,
): void {
  bursts.push({ kind: 'resolution', geometry: geom });
  if (bursts.length > MOB_ABILITY_BURST_CAP) {
    bursts.splice(0, bursts.length - MOB_ABILITY_BURST_CAP);
  }
}

export function pushMobAbilityRecatch(bursts: MobAbilityBurstEvent[], x: number, y: number): void {
  bursts.push({ kind: 'recatch', x, y });
=======
export function pushMobAbilityBurst(bursts: MobAbilityBurst[], burst: MobAbilityBurst): void {
  bursts.push(burst);
>>>>>>> origin/main
  if (bursts.length > MOB_ABILITY_BURST_CAP) {
    bursts.splice(0, bursts.length - MOB_ABILITY_BURST_CAP);
  }
}
