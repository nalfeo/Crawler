/**
 * Floor 2 faction-relationship model (ADR 0040 · D1 / D2 / D3).
 *
 * Relationship state is family-level, not per-mob: the single source of truth
 * is `world.factionRelations: Map<FamilyId, number>` (floor-scoped, clamped
 * [0,100]). Mobs carry only the `FamilyMembership` tag with `{ familyId,
 * isBoss }`; at decision time they read the shared value.
 *
 * This slice lands the data model, helpers, deterministic roster selection,
 * and the pure hate-speed-ramp helper (used by the family-aware AI in Slice 3).
 * Everything here is deterministic — no `Math.random()`, no `Date.now()`.
 */
import type { SeededRandom } from '../shared/random.js';
import type { FamilyDef } from '../shared/data/families.js';
import type { ResourceDef } from '../shared/data/resources.js';
import type { FloorBossEncounterState } from '../shared/floor-types.js';
import tuning from '../shared/data/tuning.json';

/**
 * Branded string type — a family id is nominally distinct from any other
 * string so a raw `string` cannot be silently used where a `FamilyId` is
 * expected.
 */
export type FamilyId = string & { readonly __brand: 'FamilyId' };

/** Branded resource id (same rationale as {@link FamilyId}). */
export type ResourceId = string & { readonly __brand: 'ResourceId' };

/** Convert any string into a branded {@link FamilyId}. Trusted-caller helper. */
export function asFamilyId(raw: string): FamilyId {
  return raw as FamilyId;
}

/** Convert any string into a branded {@link ResourceId}. Trusted-caller helper. */
export function asResourceId(raw: string): ResourceId {
  return raw as ResourceId;
}

/** Player-facing relationship bands (FR8, inclusive boundaries). */
export type FactionBand = 'hate' | 'hostile' | 'neutral' | 'friendly';

/** Payload emitted whenever `adjustFactionRelation` mutates a value. */
export interface FactionRelationChangedEvent {
  familyId: FamilyId;
  before: number;
  after: number;
  band: FactionBand;
  /** The band the family was in *before* this delta was applied. */
  previousBand: FactionBand;
}

/** Queued delta drained by `familyRelationshipSystem`. */
export interface FactionRelationDelta {
  familyId: FamilyId;
  delta: number;
  /** Free-form reason string for lab/HUD/telemetry surfacing. */
  reason: string;
}

/**
 * The minimal world surface this module reads/writes. Kept as a local shape so
 * `src/shared/**` -> layer rules stay clean; the fields listed here match the
 * additions to `GameWorld` in `src/core/world.ts`.
 */
export interface FactionRelationsWorldFacet {
  factionRelations: Map<FamilyId, number>;
  factionRelationEvents: FactionRelationChangedEvent[];
  factionRelationDeltas: FactionRelationDelta[];
  /** Floor extended state — use `.familyState` to access family faction data. */
  floorExtendedState: { familyState?: Floor2State } | null;
}

/** Floor-scoped state written when a Floor-2 run is initialised. */
export interface Floor2State {
  presentFamilies: FamilyId[];
  contestedResource: ResourceId;
  /** Betrayer latch — flipped true once the player attacks a Friendly family. */
  betrayerFlag: boolean;
  /**
   * Guards the reputation system. When explicitly `false`, `familyRelationshipSystem`
   * discards queued deltas without applying them and skips passive decay.
   * `undefined` / `true` = active (backwards-compatible default for labs/tests that
   * construct `Floor2State` directly).
   *
   * Set to `false` at floor init and flipped to `true` by `floor2ObjectiveTick`
   * once the Broker intro completion flag (`FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID`) is set.
   */
  reputationSystemActive?: boolean;
  /** Boss-defeated family IDs. Populated by floor2ObjectiveTick. */
  decapitatedFamilies?: Set<FamilyId>;
  /** World-space (ft) position of the exit staircase. Set on victory by popFloor2ResourceHeartStairs. */
  staircasePos?: { x: number; y: number };
  /** True once the exit staircase tile has been spawned (victory condition met). */
  staircaseSpawned?: boolean;
  /** True once the staircase is accessible to the player. */
  staircaseUnlocked?: boolean;
  /** True once the player confirms descent — terminal run state. */
  staircaseDiscovered?: boolean;
  /** Durable player-attributed non-boss kills, keyed by family id. */
  trashKillsByFamily?: Map<FamilyId, number>;
  /** Runtime den boss encounters, keyed by family id. */
  bossEncounters?: Map<FamilyId, Floor2FamilyBossEncounterState>;
}

export interface Floor2FamilyBossEncounterState extends FloorBossEncounterState {
  familyId: FamilyId;
  roomId: number;
  doorEids: number[];
  activeGoalId: string;
  /** World-space X position where this family's boss was spawned (used to drop the chest). */
  bossSpawnX?: number;
  /** World-space Y position where this family's boss was spawned (used to drop the chest). */
  bossSpawnY?: number;
}

/** Default starting relation applied to every present family (from tuning.json). */
export const DEFAULT_RELATION: number = tuning.factionRelations.defaultRelation;
/** Passive decay per second (default 0 — no automatic drift). */
export const PASSIVE_DECAY_PER_SECOND: number = tuning.factionRelations.passiveDecayPerSecond;
/** Per-lever deltas, as tuning constants. */
export const RELATION_DELTAS: Readonly<Record<string, number>> = Object.freeze({
  ...tuning.factionRelations.deltas,
});

export const RELATION_MIN = 0;
export const RELATION_MAX = 100;

/**
 * Classify a relation number into its band. Inclusive boundaries per FR8:
 *   0–24  → hate
 *   25–49 → hostile
 *   50–75 → neutral
 *   76–100 → friendly
 *
 * Values outside `[0,100]` are clamped before classification so the function
 * is total.
 */
export function bandFor(relation: number): FactionBand {
  const r = clampRelation(relation);
  if (r <= 24) return 'hate';
  if (r <= 49) return 'hostile';
  if (r <= 75) return 'neutral';
  return 'friendly';
}

/** Clamp helper — exported for reuse by tests and the lab. */
export function clampRelation(relation: number): number {
  if (!Number.isFinite(relation)) return RELATION_MIN;
  if (relation < RELATION_MIN) return RELATION_MIN;
  if (relation > RELATION_MAX) return RELATION_MAX;
  return relation;
}

/**
 * Pure hate-band speed ramp (FR9). For a hate-band mob with relation
 * `r ∈ [0, 25)`, effective move speed becomes
 *   `baseSpeed + (playerSpeed - baseSpeed) * (25 - r) / 25`
 * clamped to `[baseSpeed, playerSpeed]`. At `r = 0` the mob matches the
 * player; at `r → 25` the boost is zero.
 *
 * If `relation >= 25` (not in the hate band) or the mob is already at least
 * as fast as the player, this returns `baseSpeed` unchanged — the ramp only
 * *raises* slow mobs up to the player's speed, never past it, never lowers.
 *
 * Returns an *absolute effective speed* bracketed by `[baseSpeed, playerSpeed]`
 * — not a dimensionless multiplier — so callers apply it directly. Landing this
 * helper in Slice 1 (rather than Slice 3 where it's consumed) means Slice 3
 * doesn't have to touch these files.
 */
export function effectiveSpeedForHate(
  relation: number,
  baseSpeed: number,
  playerSpeed: number,
): number {
  if (relation >= 25) return baseSpeed;
  if (baseSpeed >= playerSpeed) return baseSpeed;
  const r = Math.max(0, relation);
  const ramp = (25 - r) / 25;
  const boosted = baseSpeed + (playerSpeed - baseSpeed) * ramp;
  if (boosted < baseSpeed) return baseSpeed;
  if (boosted > playerSpeed) return playerSpeed;
  return boosted;
}

/** Read a family's current relation, or the default if never seeded. */
export function getRelation(world: FactionRelationsWorldFacet, familyId: FamilyId): number {
  const value = world.factionRelations.get(familyId);
  return value ?? DEFAULT_RELATION;
}

/**
 * Apply a delta to a family's relation, clamp the result to `[0, 100]`, and
 * emit a `FactionRelationChangedEvent` on `world.factionRelationEvents`. This
 * is the *only* supported way to mutate a relation value — never write to
 * `world.factionRelations` directly.
 */
export function adjustFactionRelation(
  world: FactionRelationsWorldFacet,
  familyId: FamilyId,
  delta: number,
): void {
  const before = getRelation(world, familyId);
  const after = clampRelation(before + delta);
  world.factionRelations.set(familyId, after);
  world.factionRelationEvents.push({
    familyId,
    before,
    after,
    band: bandFor(after),
    previousBand: bandFor(before),
  });
}

/**
 * Queue a delta for `familyRelationshipSystem` to drain next tick. This is
 * the buffered path used by combat, quest, and emergent-event systems that
 * shouldn't apply state mutations mid-frame. Direct-apply callers (e.g. the
 * lab) can bypass and call {@link adjustFactionRelation} themselves.
 */
export function queueFactionRelationDelta(
  world: FactionRelationsWorldFacet,
  delta: FactionRelationDelta,
): void {
  world.factionRelationDeltas.push(delta);
}

/**
 * Result of {@link selectFloor2Roster} — the deterministic per-run pick of
 * present families + contested resource.
 */
export interface Floor2Roster {
  presentFamilies: FamilyId[];
  contestedResource: ResourceId;
}

/** Optional bias overrides for {@link selectFloor2Roster}. */
export interface Floor2RosterOptions {
  /**
   * Probability in [0, 1] of picking 4 families instead of 3. Default 0.4 —
   * 60% of runs seed 3 families, 40% seed 4. Documented in code to keep the
   * default legible without a separate rationale doc.
   */
  presentCountFourProbability?: number;
}

/**
 * Deterministically pick 3–4 present families and one contested resource from
 * the loaded rosters. Uses `rng` only — no `Math.random()`, no `Date.now()`.
 *
 * Same seed ⇒ identical `Floor2Roster`. Callers that want a stable choice for
 * a run should pass in a rng constructed from the run's seed.
 */
export function selectFloor2Roster(
  rng: SeededRandom,
  families: readonly FamilyDef[],
  resources: readonly ResourceDef[],
  options: Floor2RosterOptions = {},
): Floor2Roster {
  if (families.length < 4) {
    throw new Error('selectFloor2Roster requires at least 4 families in the pool');
  }
  if (resources.length < 1) {
    throw new Error('selectFloor2Roster requires at least 1 resource');
  }
  const fourProb = options.presentCountFourProbability ?? 0.4;
  const presentCount = rng.next() < fourProb ? 4 : 3;

  // Fisher–Yates on a fresh copy so we never mutate the caller's roster.
  const shuffled = families.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const presentFamilies = shuffled.slice(0, presentCount).map((f) => asFamilyId(f.id));

  const resourceIndex = rng.nextInt(0, resources.length - 1);
  const contestedResource = asResourceId(resources[resourceIndex]!.id);

  return { presentFamilies, contestedResource };
}

/**
 * (Re)initialise `world.factionRelations` to `DEFAULT_RELATION` for every
 * present family. Called by the Floor-2 scenario wiring session (Slice 8) but
 * exported here so tests and the lab can seed it directly.
 */
export function initializeFactionRelations(
  world: FactionRelationsWorldFacet,
  presentFamilies: readonly FamilyId[],
): void {
  world.factionRelations.clear();
  for (const id of presentFamilies) {
    world.factionRelations.set(id, DEFAULT_RELATION);
  }
}
