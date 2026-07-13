import { fovSystem, type GameWorld } from '../../core/index.js';
import {
  runCoreSimulationStep,
  type CoreSimulationSystem,
} from '../../core/simulation-core-step.js';
import type { InputState } from '../../shared/input.js';

/**
 * A deterministic ECS system: a pure `(world) => void` mutator. Used for the
 * per-step pre/post hooks the scene injects (e.g. headless-parity AI, lab
 * instrumentation).
 */
export type SimulationSystem = CoreSimulationSystem;

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
 * NOTE: the headless Floor-1 win-rate gate runs `src/game/ai/simulation-step.ts`,
 * which now delegates to the same `runCoreSimulationStep` helper as this wrapper.
 * Core ordering is no longer duplicated between visual/headless pipelines.
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
  runCoreSimulationStep(world, inputState, {
    preSystems: hooks.preSystems,
    postSystems: hooks.postSystems,
    afterInput: hooks.afterInput,
    runFovSystem: hooks.runFovSystem ?? fovSystem,
  });
}
