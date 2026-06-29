import {
  aoeOnImpactPostDamage,
  aoeOnImpactPreDamage,
  areaDamageSystem,
  beamSystem,
  collisionSystem,
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
}

/**
 * Runs ONE fixed-timestep simulation step: the full ordered ECS system pipeline
 * extracted verbatim from `MainGameScene.update()`. The call order and arguments
 * are intentionally identical to the original inline loop body — this is a
 * behavior-preserving extraction whose equivalence is proven by the headless
 * Floor-1 win-rate gate.
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
  meleeSwingSystem(world);
  knockbackSystem(world);
  beamSystem(world);
  trapSystem(world, collision);
  itemPickupSystem(world, collision);
  harvestSystem(world);
  dropSystem(world);
  deathTimerSystem(world);
  spawnAnimSystem(world);
  healthSystem(world);
  lifetimeSystem(world);
  projectileCleanupSystem(world);
  doorSystem(world);
  fovSystem(world);
  safeRoomSystem(world);
  npcSystem(world);

  for (const sys of hooks.postSystems ?? []) {
    sys(world);
  }
}
