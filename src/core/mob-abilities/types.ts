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
export type MobAbilityPhase = 'cooldown' | 'telegraph';

/** Public cue phase surfaced to the renderer. */
export type MobAbilityCuePhase = 'telegraph' | 'resolved';

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

export type MobAbilityGeometry = MobAbilityCircleGeometry;

/**
 * A named handler that applies one ability's committed effect at resolution.
 * Handlers are ordinary typed functions (one per ability kind), never derived
 * from arbitrary catalog values.
 */
export type MobAbilityResolveHandler = (world: GameWorld, ctx: MobAbilityResolveContext) => void;

/** Everything a resolve handler needs, all committed at telegraph start. */
export interface MobAbilityResolveContext {
  readonly abilityId: string;
  readonly casterEid: number;
  /** Stable per-cast source key for owned status effects (`mob-ability:<id>:<eid>`). */
  readonly sourceId: string;
  readonly geometry: MobAbilityGeometry;
  /** Target entity locked at telegraph start; `null`/invalid targets are tolerated. */
  readonly targetEid: number | null;
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
  /** Committed geometry footprint (radius etc.); position is locked at cast. */
  readonly geometry: { readonly kind: 'circle'; readonly radiusFt: number };
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
}

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
   * Per-EID generation token, set on each `registerMobAbility` and cleared on
   * `clearMobAbility`. Compared against `MobAbilityInstanceState.registrationToken`
   * in `isCasterValid` to catch same-archetype EID recycling within a tick.
   */
  readonly registrationTokens: Map<number, number>;
  /** Monotonically increasing counter; incremented on each registration. */
  nextToken: number;
}

/** Create the default-off, empty runtime state for a fresh world. */
export function createMobAbilityRuntime(): MobAbilityRuntime {
  return {
    enabled: false,
    encounterActive: false,
    byEntity: new Map(),
    cues: [],
    registrationTokens: new Map(),
    nextToken: 0,
  };
}

/** Stable per-cast source key for status effects owned by a caster's ability. */
export function mobAbilitySourceId(abilityId: string, casterEid: number): string {
  return `mob-ability:${abilityId}:${casterEid}`;
}
