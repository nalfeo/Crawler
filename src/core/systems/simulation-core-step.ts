import type { InputState } from '../../shared/input.js';
import type { GameWorld } from '../world.js';
import { aoeOnImpactPostDamage, aoeOnImpactPreDamage } from './aoeOnImpactSystem.js';
import { areaDamageSystem } from './areaDamageSystem.js';
import { beamSystem } from './beamSystem.js';
import { collisionSystem } from './collisionSystem.js';
import { corpseStepSystem } from './corpseStepSystem.js';
import { damageSystem } from './damageSystem.js';
import { deathTimerSystem } from './deathTimerSystem.js';
import { doorSystem } from './doorSystem.js';
import { dropSystem } from './dropSystem.js';
import { fovSystem } from './fovSystem.js';
import { harvestSystem } from './harvestSystem.js';
import { healthSystem } from './healthSystem.js';
import { itemPickupSystem } from './itemPickupSystem.js';
import { knockbackSystem } from './knockbackSystem.js';
import { lifetimeSystem } from './lifetimeSystem.js';
import { meleeSwingSystem } from './meleeSwingSystem.js';
import { movementSystem } from './movementSystem.js';
import { npcSystem } from './npcSystem.js';
import { playerInputSystem } from './playerInputSystem.js';
import { projectileCleanupSystem } from './projectileCleanupSystem.js';
import { returningProjectileSystem } from './returningProjectileSystem.js';
import { safeRoomSystem } from '../safe-space.js';
import { spawnAnimSystem } from './spawnAnimSystem.js';
import { trapSystem } from './trapSystem.js';

export type CoreSimulationSystem = (world: GameWorld) => void;

export interface RunCoreSimulationStepOptions {
  preSystems?: ReadonlyArray<CoreSimulationSystem>;
  postSystems?: ReadonlyArray<CoreSimulationSystem>;
  afterInput?: () => void;
  runFovSystem?: CoreSimulationSystem;
  meleeBroadPhase?: boolean;
  beamBroadPhase?: boolean;
}

/**
 * Shared deterministic core step used by both visual and headless simulation
 * wrappers so call ordering is defined in exactly one place.
 */
export function runCoreSimulationStep(
  world: GameWorld,
  inputState: InputState,
  options: RunCoreSimulationStepOptions = {},
): void {
  playerInputSystem(world, inputState);
  for (const sys of options.preSystems ?? []) {
    sys(world);
  }

  options.afterInput?.();

  movementSystem(world);
  returningProjectileSystem(world);
  const collision = collisionSystem(world);
  aoeOnImpactPreDamage(world);
  damageSystem(world, collision);
  aoeOnImpactPostDamage(world);
  areaDamageSystem(world, collision);
  meleeSwingSystem(world, options.meleeBroadPhase === false ? undefined : collision);
  knockbackSystem(world);
  beamSystem(world, options.beamBroadPhase === false ? undefined : collision);
  trapSystem(world, collision);
  itemPickupSystem(world, collision);
  harvestSystem(world);
  dropSystem(world);
  corpseStepSystem(world);
  deathTimerSystem(world);
  spawnAnimSystem(world);
  healthSystem(world);
  lifetimeSystem(world);
  projectileCleanupSystem(world);
  doorSystem(world);
  (options.runFovSystem ?? fovSystem)(world);
  safeRoomSystem(world);
  npcSystem(world);

  for (const sys of options.postSystems ?? []) {
    sys(world);
  }
}
