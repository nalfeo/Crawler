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
  statSystem,
  manaSystem,
  type GameWorld,
} from '../../core/index.js';
import {
  questSystem,
  floorObjectiveSystem,
  floor1EnemyDirectorSystem,
  floor1PlayerStatSystem,
  weaponSystem,
  statsSystem,
  enemyAISystem,
  levelSystem,
  skillSystem,
  abilitySystem,
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

  // Faithful pre-movement game systems (mirrors MainGameScene preSystems order).
  // Without these the headless pipeline silently drifts from the visual game:
  // statsSystem recomputes player combat stats, statSystem recomputes the
  // EffectiveStats store (folding level-up core-stat points into crit/dodge so
  // the damage path sees them), manaSystem derives the Wisdom-scaled MP pool and
  // regenerates MP, floor1PlayerStatSystem applies Floor 1 stat scaling, and
  // enemyAISystem drives enemy movement intent.
  statsSystem(world);
  statSystem(world);
  manaSystem(world);
  if (options.enableFloor1 && world.floor1) {
    floor1PlayerStatSystem(world);
  }
  enemyAISystem(world);

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

  // Faithful player-progression systems (mirrors MainGameScene postSystems).
  // levelSystem is the critical one: it converts accumulated XP into level-ups.
  // It MUST run before floorObjectiveSystem/questSystem so objectives that read
  // playerLevel.level (e.g. Floor 1 "reach level 2") see this frame's value.
  levelSystem(world);
  skillSystem(world);
  abilitySystem(world);

  // Floor 1 exposes no stat-allocation UI, so a level-up must not park the
  // simulation on the `level_up` flag. The visual game clears it every frame in
  // MainGameScene (see the `world.state === 'level_up'` reset there); the
  // headless pipeline must do the same or it stays stuck in `level_up` forever —
  // which starves every `state === 'playing'`-gated system (notably
  // floor1ObjectiveTick, so "reach level 2" never latches and the tutorial quest
  // never completes). Clear it before the Floor 1 systems run this frame.
  if (world.state === 'level_up') {
    world.state = 'playing';
  }

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
