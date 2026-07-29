/**
 * Canonical size + weight definitions for every "physics body" entity class.
 *
 * This module is the runtime mirror of
 * `docs/knowledge/game-design/entity-sizing.md`. Drift between the two is a
 * CI failure (see `scripts/agent/health/check-physics-defs-sync.ts`).
 *
 * ## Slice-1 invariant
 *
 * Every numeric value here is set to **today's shipping sprite half-extent**
 * (or the shipping spawner default weight). That means
 * `tests/headless/collision-pair-parity.test.ts` is bit-identical before and
 * after Size wiring — no gameplay tuning happens in Slice 1. Retuning to the
 * "designed" body sizes / weights is a later slice with its own win-rate
 * sweep.
 *
 * ## Shapes
 *
 * - `circle` (SHAPE_CIRCLE / 0) — bounding volume is a disc of `radius` ft.
 *   `halfWidth` / `halfHeight` are 0 and MUST NOT be read.
 * - `box`    (SHAPE_BOX / 1)    — bounding volume is an axis-aligned box of
 *   `halfWidth * halfHeight` ft. `radius` is 0 and MUST NOT be read (unless
 *   a system wants a "conservative circumscribing radius" — which is
 *   `Math.hypot(halfWidth, halfHeight)`).
 *
 * See `src/core/physics-body.ts` for the read-side helpers that consumers
 * (`collisionSystem`, `knockbackSystem`, `weaponSystem`, etc.) call instead
 * of reaching into the stores directly. ADR 0044 for the decision.
 */

/** Numeric encoding of `shape` in the `Size` component store. */
export const SHAPE_CIRCLE = 0 as const;
export const SHAPE_BOX = 1 as const;
export type ShapeCode = typeof SHAPE_CIRCLE | typeof SHAPE_BOX;

/**
 * Weight (lb) at or above which `knockbackSystem` treats the target as
 * immovable: it drops the Knockback component without displacing the entity.
 * Walls (10 000 lb per `entity-sizing.md`) hit this by design.
 *
 * Independent of the `Immovable` tag component — an entity qualifies for
 * short-circuit via *either* rule. See ADR 0044 (Slice 2).
 */
export const IMMOVABLE_THRESHOLD = 10_000 as const;

/**
 * Median mob weight (lb) used as the 1.0× knockback baseline in
 * `knockbackSystem`. A target at this weight sees knockback identical to
 * pre-Slice-2 behavior; lighter targets move farther, heavier targets move
 * less. Writers keep their configured knockback speeds; scaling happens
 * reader-side. See ADR 0044 (Slice 2) and `entity-sizing.md`
 * §"Knockback baseline math".
 */
export const KNOCKBACK_WEIGHT_BASELINE_LB = 120 as const;

/**
 * Upper bound on the reader-side `weightScale = BASELINE / weight` factor
 * in `knockbackSystem`. Without this cap a rat @ 6 lb would receive 20×
 * displacement and a slime @ 20 lb would receive 6× — enough to punt light
 * mobs across a room from a single sword swing, breaking game feel. 2.5×
 * puts the clamp boundary at 48 lb (below the 60 lb "light mob" data
 * anchor), so authored weights ≥ 48 lb scale linearly and only extreme
 * lightweights are clamped. Heavier-than-baseline targets are unaffected
 * (`weightScale ≤ 1.0` there).
 *
 * Design-owned constant: ADR 0044 (Slice 2 refinement). Authored per-mob
 * weights are intentionally left unchanged in Slice 2; retuning the mob
 * registry is a later `ai-combat-balance` slice.
 */
export const KNOCKBACK_WEIGHT_SCALE_MAX = 2.5 as const;

/** A single physics-body definition. Keys are named for the runtime store. */
export interface PhysicsBodyDef {
  /** Bounding radius in ft. Non-zero for `SHAPE_CIRCLE`; 0 for `SHAPE_BOX`. */
  readonly radius: number;
  /** Half-width in ft. Non-zero for `SHAPE_BOX`; 0 for `SHAPE_CIRCLE`. */
  readonly halfWidth: number;
  /** Half-height in ft. Non-zero for `SHAPE_BOX`; 0 for `SHAPE_CIRCLE`. */
  readonly halfHeight: number;
  /** `SHAPE_CIRCLE` or `SHAPE_BOX`. */
  readonly shape: ShapeCode;
  /** Default weight in lb. May be overridden by the spawner (mobs, drops). */
  readonly weight: number;
}

const circle = (radius: number, weight: number): PhysicsBodyDef => ({
  radius,
  halfWidth: 0,
  halfHeight: 0,
  shape: SHAPE_CIRCLE,
  weight,
});

const box = (halfWidth: number, halfHeight: number, weight: number): PhysicsBodyDef => ({
  radius: 0,
  halfWidth,
  halfHeight,
  shape: SHAPE_BOX,
  weight,
});

/**
 * Static-shape registry. Every entry MUST equal today's shipping sprite
 * half-extents so `collision-pair-parity.test.ts` stays green.
 *
 * Dynamic bodies whose size is chosen per-spawn (mobs from `MobTemplate`,
 * NPCs from `NpcDef`, props from `DecorationDef`, beams from cast length,
 * area attacks / melee swings from ability radius) are NOT in this
 * registry — they read from their def and write Size directly at spawn.
 * The `mob-*` guideline rows below are for the sync sheet only; no spawner
 * looks them up.
 */
export const PHYSICS_BODIES = {
  // --- Combatants ---
  /**
   * Player. Foot-footprint collider (3 ft across), deliberately smaller than the
   * ~5.75 ft drawn sprite — a full-height collider could not fit a 1-tile
   * (4 ft) corridor. Render size lives in `entity-sprite-mappings.json`.
   */
  player: circle(1.5, 180),

  /**
   * Baseline / archetype rows kept in lock-step with entity-sizing.md by
   * `check:physics-defs-sync`.
   *
   * `mob-baseline` IS live: `spawnEnemy` and `spawnBehaviorEnemy` in
   * `src/core/spawners/combatants.ts` read `PHYSICS_BODIES['mob-baseline']`
   * as the default when a MobTemplate doesn't specify its own body. The
   * light/heavy/boss rows are archetype guidelines that individual mob defs
   * can pattern-match against; they are not read by a spawner today, but
   * the sync gate still keeps them from drifting from the doc.
   */
  'mob-baseline': circle(1.0, 120),
  'mob-light': circle(0.75, 60),
  'mob-heavy': circle(1.25, 240),
  'mob-boss': box(1.5, 1.5, 800),

  /** Quest-giver / non-hostile NPC. Sprite is per-def; guideline shown here. */
  npc: circle(1.0, 150),

  /** Structural spawner (turret, egg-sac, etc.). Sprite 3×3 ft. */
  'spawner-structure': circle(1.5, 200),

  // --- Projectiles ---
  /** Bullet/arrow/thrown small object. Sprite 0.75×0.75 ft. */
  'projectile-bullet': circle(0.375, 1),
  /**
   * Beam segment. `halfWidth` is per-cast (length/2); registry pins the
   * on-shipping `halfHeight` (0.25 ft ⇐ sprite height 0.5 ft).
   */
  'beam-segment': box(0, 0.25, 1),

  // --- Pickups & drops ---
  /** XP gem. Sprite 1×1 ft. */
  'xp-gem': circle(0.5, 1),
  /** Gold pile. Sprite 1×1 ft today (spawner default `spawnGold`). */
  gold: circle(0.5, 1),
  /** Dropped item. Sprite 1.25×1.25 ft. */
  'dropped-item': circle(0.625, 5),

  // --- World objects ---
  /**
   * Trap. Sprite 1.5×1.5 ft. No Weight is set on the trap entity today
   * (traps aren't knockback targets), so `weight` here is nominal only —
   * it does NOT flow into the trap spawner. Slice 2 may promote it.
   */
  trap: circle(0.75, 100),
  /** Harvestable node (mushroom / lichen / etc.). Sprite 1×1 ft. */
  'harvestable-node': circle(0.5, 50),

  /**
   * Wall segment. Not currently spawned via a `spawnWall(...)` call —
   * walls are tile-authored — but the size row exists for the doc.
   */
  wall: box(0.5, 0.5, 10_000),
  /** Door. Sprite 1×1 ft. */
  door: box(0.5, 0.5, 500),
} as const;

export type PhysicsBodyId = keyof typeof PHYSICS_BODIES;

/**
 * Look up a physics-body def by id. Throws (rather than returning undefined)
 * because a typo at a spawner call site is a programmer bug, not a runtime
 * condition to recover from.
 */
export function getPhysicsBody(id: PhysicsBodyId): PhysicsBodyDef {
  const def = PHYSICS_BODIES[id];
  if (def === undefined) {
    throw new Error(`getPhysicsBody: unknown id "${String(id)}"`);
  }
  return def;
}
