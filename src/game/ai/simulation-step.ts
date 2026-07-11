/**
 * Headless simulation step — pure ECS core pipeline.
 *
 * This is the step runner used by the headless AI runner (`headless-runner.ts`)
 * and by the Floor 1 win-rate gate. It contains ONLY the deterministic ECS core
 * pipeline (identical to `src/engine/sim/simulation-step.ts`). All floor-specific
 * and scenario-specific systems are injected by the CALLER via `options.preSystems`
 * and `options.postSystems` — the single source of truth for that ordering is
 * `src/bootstrap/floor-main-scene-options.ts` (canonical `preSystems`/`postSystems`
 * shared by both visual and headless). This eliminates the historical ordering
 * divergences for `weaponSystem` and `floor1EnemyDirectorSystem` tracked in
 * issue #663.
 */
import {
  playerInputSystem,
  movementSystem,
  returningProjectileSystem,
  collisionSystem,
  corpseStepSystem,
  aoeOnImpactPreDamage,
  aoeOnImpactPostDamage,
  damageSystem,
  areaDamageSystem,
  meleeSwingSystem,
  knockbackSystem,
  beamSystem,
  trapSystem,
  itemPickupSystem,
  harvestSystem,
  dropSystem,
  deathTimerSystem,
  spawnAnimSystem,
  healthSystem,
  lifetimeSystem,
  projectileCleanupSystem,
  doorSystem,
  fovSystem,
  safeRoomSystem,
  npcSystem,
  type GameWorld,
} from '../../core/index.js';
import type { InputState } from '../../shared/input.js';

/**
 * System pipeline options.
 */
export interface SimulationOptions {
  /** Custom systems to run before core pipeline */
  preSystems?: ReadonlyArray<(world: GameWorld) => void>;
  /** Custom systems to run after core pipeline */
  postSystems?: ReadonlyArray<(world: GameWorld) => void>;
  /**
   * Melee hit-detection broad-phase mode. Defaults to `true` (grid): melee uses
   * the frame's fresh spatial-hash grid as a superset broad-phase, preserving
   * legacy iteration order via a canonical rank map (identical-by-construction).
   * Set to `false` to force the legacy full-`[Health,Position]` scan.
   *
   * This is a determinism rollback / guard seam, not a gameplay toggle: both
   * paths are proven to produce byte-identical outcomes. It lets the permanent
   * pipeline differential regression test drive grid-vs-fallback through the
   * REAL full pipeline (so a future system inserted into the collision→melee
   * seam that moved combat targets would trip the guard), and gives ops a
   * one-line kill-switch if a grid regression is ever suspected in the field.
   */
  meleeBroadPhase?: boolean;
  /**
   * Beam hit-detection broad-phase mode. Defaults to `true` (grid): beamSystem
   * uses the frame's spatial-hash grid as a superset broad-phase, preserving legacy
   * iteration order via a canonical rank map (identical-by-construction). Set to
   * `false` to force the legacy full-`[Health,Position]` scan.
   *
   * Like `meleeBroadPhase`, this is a determinism rollback / guard seam, not a
   * gameplay toggle: both paths produce byte-identical outcomes. Unlike melee, the
   * grid is STALE for beams (knockbackSystem moves entities after the grid is
   * built), so the broad-phase radius is inflated by `world.maxKnockbackStepThisFrame`
   * to stay a guaranteed superset. The pipeline differential regression test drives
   * grid-vs-fallback through the REAL full pipeline so a future target-moving or
   * target-spawning system inserted into the collision→beam seam trips the guard.
   */
  beamBroadPhase?: boolean;
}

/**
 * Execute one simulation step (one fixed timestep).
 *
 * This is the pure ECS core pipeline — no rendering, no Phaser, no floor-specific
 * game systems. Updates world.frameCount and world.elapsedMs.
 *
 * Floor-specific and scenario-specific systems (e.g. `weaponSystem`,
 * `floor1EnemyDirectorSystem`, `levelSystem`, `floorObjectiveSystem`) are
 * injected by the CALLER via `options.preSystems` and `options.postSystems`.
 * The canonical ordering for those systems is defined in
 * `src/bootstrap/floor-main-scene-options.ts` (the visual pipeline's
 * `createFloorMainSceneOptions()`), and `headless-runner.ts` uses that same
 * source so both pipelines derive their order from one shared definition
 * (resolving the ordering divergences tracked in issue #663).
 *
 * The `level_up` state reset (needed so the headless loop doesn't park on
 * a level-up frame) must be performed by the CALLER between steps — mirroring
 * the visual game's `MainGameScene.update()` which resets the state outside
 * the sim step.
 *
 * @param world - Game world to simulate
 * @param input - Input state for this frame
 * @param deltaMs - Time delta in milliseconds (typically GAME.DELTA_MS)
 * @param options - Optional injected systems and broad-phase guards
 */
export function runSimulationStep(
  world: GameWorld,
  input: InputState,
  deltaMs: number,
  options: SimulationOptions = {},
): void {
  world.frameCount += 1;
  world.elapsedMs += deltaMs;

  playerInputSystem(world, input);

  for (const sys of options.preSystems ?? []) {
    sys(world);
  }

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
  meleeSwingSystem(world, options.meleeBroadPhase === false ? undefined : collision);
  knockbackSystem(world);
  // beamSystem reuses the same grid, but knockbackSystem above has since moved
  // entities, so the grid is STALE by up to world.maxKnockbackStepThisFrame.
  // beamSystem inflates its broad-phase radius by that bound to stay a guaranteed
  // superset; guarded by tests/headless/beam-broadphase-pipeline-determinism.test.ts.
  beamSystem(world, options.beamBroadPhase === false ? undefined : collision);
  trapSystem(world, collision);
  itemPickupSystem(world, collision);
  harvestSystem(world);
  dropSystem(world);
  // Corpse step: the player brushing a still-lingering corpse has a small
  // chance to burst it into shards. See engine/sim/simulation-step.ts for the
  // full ordering rationale — same seam here (after dropSystem, before
  // deathTimerSystem) so a triggered corpse is reaped this frame.
  corpseStepSystem(world);
  deathTimerSystem(world);
  spawnAnimSystem(world);
  healthSystem(world);
  lifetimeSystem(world);
  projectileCleanupSystem(world);
  doorSystem(world);
  fovSystem(world);
  safeRoomSystem(world);
  npcSystem(world);

  for (const sys of options.postSystems ?? []) {
    sys(world);
  }
}
