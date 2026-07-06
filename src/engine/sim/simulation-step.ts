import {
  aoeOnImpactPostDamage,
  aoeOnImpactPreDamage,
  areaDamageSystem,
  beamSystem,
  collisionSystem,
  corpseStepSystem,
  damageSystem,
  deathTimerSystem,
  doorSystem,
  dropSystem,
  fovSystem,
  harvestSystem,
  healthSystem,
  itemPickupSystem,
  knockbackSystem,
  lifetimeSystem,
  meleeSwingSystem,
  movementSystem,
  npcSystem,
  playerInputSystem,
  projectileCleanupSystem,
  returningProjectileSystem,
  safeRoomSystem,
  spawnAnimSystem,
  trapSystem,
  type GameWorld,
} from '../../core/index.js';
import type { InputState } from '../../shared/input.js';

/**
 * A deterministic ECS system: a pure `(world) => void` mutator. Used for the
 * per-step pre/post hooks the scene injects (e.g. headless-parity AI, lab
 * instrumentation).
 */
export type SimulationSystem = (world: GameWorld) => void;

/** Optional hooks woven into a single fixed-timestep simulation step. */
export interface SimulationStepHooks {
  /**
   * Systems run AFTER `playerInputSystem` and BEFORE the world-mutating
   * simulation systems — the scene's `options.preSystems`.
   */
  preSystems?: ReadonlyArray<SimulationSystem>;
  /**
   * Systems run AFTER `npcSystem` (the tail of the pipeline) — the scene's
   * `options.postSystems`.
   */
  postSystems?: ReadonlyArray<SimulationSystem>;
  /**
   * Runs after `playerInputSystem` + `preSystems`, immediately before
   * `movementSystem`. This is the EXACT seam where the scene drains its paused
   * single-step queue (`pendingSimulationSteps`) and zeroes its accumulator, so
   * the original interleaved call order is preserved byte-for-byte.
   */
  afterInput?: () => void;
  /**
   * Overrides the built-in `fovSystem` call in the pipeline. When provided, the
   * scene supplies a wrapper that runs `fovSystem` while timing it (engine-only
   * perf telemetry) so the FOV granularity knob is measurable in the lab. The
   * override MUST still run `fovSystem(world)` exactly once with identical
   * semantics — it exists purely to instrument, not to alter, the step.
   */
  runFovSystem?: SimulationSystem;
}

/**
 * Runs ONE fixed-timestep simulation step: the full ordered ECS system pipeline
 * extracted from `MainGameScene.update()`. The call order and arguments match the
 * original inline loop body — this is the behavior-preserving extraction of the
 * VISUAL pipeline (the scene injects the Floor 1 pre/post systems via `hooks`).
 *
 * NOTE: the headless Floor-1 win-rate gate does NOT run this function — it runs a
 * SEPARATE hand-maintained mirror (`src/game/ai/simulation-step.ts`) which is an
 * APPROXIMATION with known ordering divergences (director + weapon absolute
 * position, tracked in issue #663), not a byte-identical copy. Treat the gate as a
 * close proxy for shipped behavior, not a proof of exact cross-pipeline equivalence.
 *
 * `collisionSystem` is run once and its result threaded into the systems that
 * consume it (`damageSystem`, `areaDamageSystem`, `trapSystem`,
 * `itemPickupSystem`) within this step; it does not escape the function.
 *
 * Single-layer (src/engine -> src/core only); deterministic (no Math.random /
 * Date.now / wall-clock reads).
 */
export function runSimulationStep(
  world: GameWorld,
  inputState: InputState,
  hooks: SimulationStepHooks = {},
): void {
  playerInputSystem(world, inputState);
  for (const sys of hooks.preSystems ?? []) {
    sys(world);
  }

  hooks.afterInput?.();

  movementSystem(world);
  returningProjectileSystem(world);
  const collision = collisionSystem(world);
  aoeOnImpactPreDamage(world);
  damageSystem(world, collision);
  aoeOnImpactPostDamage(world);
  areaDamageSystem(world, collision);
  // meleeSwingSystem uses this frame's fresh spatial-hash grid (built by
  // collisionSystem above) as a superset broad-phase. That is only sound while
  // nothing moves a combat target between the grid build and here — do NOT insert
  // a target-translating system into this seam without re-proving determinism.
  // The invariant is guarded by tests/headless/melee-broadphase-pipeline-determinism.test.ts.
  meleeSwingSystem(world, collision);
  knockbackSystem(world);
  // beamSystem reuses the same grid, but knockbackSystem above has since moved
  // entities, so the grid is STALE by up to world.maxKnockbackStepThisFrame (set by
  // knockbackSystem). beamSystem inflates its broad-phase radius by exactly that
  // bound to remain a guaranteed superset, preserving legacy iteration order via a
  // canonical rank map (identical-by-construction). Do NOT insert a target-moving
  // OR target-spawning system into the collision→beam seam without re-proving the
  // bound; guarded by tests/headless/beam-broadphase-pipeline-determinism.test.ts.
  beamSystem(world, collision);
  trapSystem(world, collision);
  itemPickupSystem(world, collision);
  harvestSystem(world);
  dropSystem(world);
  // Corpse step: the player brushing a still-lingering corpse has a small
  // chance to burst it into shards. Runs AFTER dropSystem (which is what
  // stamps freshly-killed enemies with DeathTimer this frame) so a kill and a
  // simultaneous step both resolve this frame, and BEFORE deathTimerSystem so
  // a triggered corpse (its DeathTimer.remainingMs zeroed by applyDamage) is
  // reaped in the same frame instead of lingering one extra tick.
  corpseStepSystem(world);
  deathTimerSystem(world);
  spawnAnimSystem(world);
  healthSystem(world);
  lifetimeSystem(world);
  projectileCleanupSystem(world);
  doorSystem(world);
  (hooks.runFovSystem ?? fovSystem)(world);
  safeRoomSystem(world);
  npcSystem(world);

  for (const sys of hooks.postSystems ?? []) {
    sys(world);
  }
}
