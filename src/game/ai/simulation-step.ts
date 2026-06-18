/**
 * Core simulation loop extracted from MainGameScene.
 *
 * Pure ECS simulation step that can be used by both Phaser (visual mode)
 * and headless runner (maximum speed mode).
 */
import {
  playerInputSystem,
  movementSystem,
  returningProjectileSystem,
  collisionSystem,
  aoeOnImpactPreDamage,
  aoeOnImpactPostDamage,
  damageSystem,
  areaDamageSystem,
  meleeSwingSystem,
  knockbackSystem,
  beamSystem,
  trapSystem,
  itemPickupSystem,
  dropSystem,
  deathTimerSystem,
  healthSystem,
  lifetimeSystem,
  projectileCleanupSystem,
  doorSystem,
  fovSystem,
  safeRoomSystem,
  npcSystem,
  type GameWorld,
} from '../../core/index.js';
import {
  questSystem,
  floorObjectiveSystem,
  floor1EnemyDirectorSystem,
  weaponSystem,
} from '../index.js';
import type { InputState } from '../../shared/input.js';

/**
 * System pipeline options.
 */
export interface SimulationOptions {
  /** Custom systems to run before core pipeline */
  preSystems?: ReadonlyArray<(world: GameWorld) => void>;
  /** Custom systems to run after core pipeline */
  postSystems?: ReadonlyArray<(world: GameWorld) => void>;
  /** Enable Floor 1 scenario systems */
  enableFloor1?: boolean;
}

/**
 * Execute one simulation step (one fixed timestep).
 *
 * This is the pure ECS simulation loop - no rendering, no Phaser.
 * Updates world.frameCount and world.elapsedMs.
 *
 * @param world - Game world to simulate
 * @param input - Input state for this frame
 * @param deltaMs - Time delta in milliseconds (typically GAME.DELTA_MS)
 * @param options - Optional custom systems
 */
export function runSimulationStep(
  world: GameWorld,
  input: InputState,
  deltaMs: number,
  options: SimulationOptions = {},
): void {
  world.frameCount += 1;
  world.elapsedMs += deltaMs;

  // Core ECS pipeline (order matters)
  playerInputSystem(world, input);

  for (const sys of options.preSystems ?? []) {
    sys(world);
  }

  movementSystem(world);
  returningProjectileSystem(world);
  weaponSystem(world);
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
  dropSystem(world);
  deathTimerSystem(world);
  healthSystem(world);
  lifetimeSystem(world);
  projectileCleanupSystem(world);
  doorSystem(world);
  fovSystem(world);
  safeRoomSystem(world);
  npcSystem(world);

  // Floor 1 specific systems
  if (options.enableFloor1 && world.floor1) {
    floorObjectiveSystem(world);
    floor1EnemyDirectorSystem(world);
    questSystem(world);
  }

  for (const sys of options.postSystems ?? []) {
    sys(world);
  }
}
