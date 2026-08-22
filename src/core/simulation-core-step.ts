import type { InputState } from '../shared/input.js';
import type { GameWorld } from './world.js';
import { aoeOnImpactPostDamage, aoeOnImpactPreDamage } from './systems/aoeOnImpactSystem.js';
import { areaDamageSystem } from './systems/areaDamageSystem.js';
import { beamSystem } from './systems/beamSystem.js';
import { bloodyFootprintSystem } from './systems/bloodyFootprintSystem.js';
import { collisionSystem } from './systems/collisionSystem.js';
import { corpseStepSystem } from './systems/corpseStepSystem.js';
import { damageSystem } from './systems/damageSystem.js';
import { deathTimerSystem } from './systems/deathTimerSystem.js';
import { doorSystem } from './systems/doorSystem.js';
import { dropSystem } from './systems/dropSystem.js';
import { fovSystem } from './systems/fovSystem.js';
import { harvestSystem } from './systems/harvestSystem.js';
import { bossChestPickupSystem } from './systems/bossChestPickupSystem.js';
import { healthSystem } from './systems/healthSystem.js';
import { homingSystem } from './systems/homingSystem.js';
import { itemPickupSystem } from './systems/itemPickupSystem.js';
import { knockbackSystem } from './systems/knockbackSystem.js';
import { lifetimeSystem } from './systems/lifetimeSystem.js';
import { meleeSwingSystem } from './systems/meleeSwingSystem.js';
import { movementSystem } from './systems/movementSystem.js';
import { npcSystem } from './systems/npcSystem.js';
import { playerInputSystem } from './systems/playerInputSystem.js';
import { projectileCleanupSystem } from './systems/projectileCleanupSystem.js';
import { returningProjectileSystem } from './systems/returningProjectileSystem.js';
import { safeRoomSystem } from './safe-space.js';
import { spawnAnimSystem } from './systems/spawnAnimSystem.js';
import { trapSystem } from './systems/trapSystem.js';

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

  homingSystem(world);
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
  bossChestPickupSystem(world);
  dropSystem(world);
  corpseStepSystem(world);
  bloodyFootprintSystem(world);
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
