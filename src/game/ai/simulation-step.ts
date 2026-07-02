/**
 * Headless Floor 1 simulation loop.
 *
 * This is the hand-maintained mirror that the headless AI runner
 * (`headless-runner.ts`) and the Floor 1 win-rate gate execute at maximum speed.
 * The VISUAL game does NOT run this file — `MainGameScene` runs the engine step
 * (`src/engine/sim/simulation-step.ts`) with scene-injected pre/post systems.
 * The two pipelines are kept close by hand but are NOT byte-identical; known
 * ordering divergences (director + weapon absolute position) are tracked in
 * issue #663.
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
  statSystem,
  manaSystem,
  statusEffectSystem,
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
  achievementSystem,
  spawnerSystem,
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

  // Pre-movement game systems. This APPROXIMATES the visual game's preSystems
  // (src/bootstrap/floor-main-scene-options.ts) but is NOT a byte-for-byte mirror:
  // this headless pipeline is hand-maintained separately, and several systems the
  // visual game runs in preSystems sit ELSEWHERE here -- weaponSystem runs
  // post-movement and floor1EnemyDirectorSystem runs post-core. spawnerSystem runs
  // HERE (pre-movement) while the director runs post-core, so -- unlike the visual
  // pipeline, where they are immediately adjacent -- the whole core ECS pipeline
  // runs between them; only the weaker "spawner before director" ordering is shared
  // across both pipelines. These absolute-position divergences are known and
  // tracked in issue #663.
  // Without the systems below the headless pipeline silently drifts from visual:
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
  statusEffectSystem(world);
  enemyAISystem(world);
  spawnerSystem(world);

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

  // Floor 1 specific systems.
  // NOTE: floor1EnemyDirectorSystem runs HERE (post-core: after movement/damage/
  // death) in this headless pipeline, but the visual game runs it PRE-core (in
  // preSystems). spawnerSystem still runs earlier this frame (pre-movement, above),
  // so the director counts this frame's freshly-spawned children -- but unlike the
  // visual pipeline the two are NOT adjacent here (the core ECS pipeline runs
  // between them). This absolute-position divergence makes the headless win-rate
  // gate an APPROXIMATE proxy for shipped behavior, not a byte-identical
  // equivalence: conservative on the damage-order axis (visual's director sees a
  // fatally-hit enemy as alive one frame longer) yet only a rough proxy on the
  // movement-distance axis. Bounded to one-frame (~16ms) effects; tracked in
  // issue #663.
  if (options.enableFloor1 && world.floor1) {
    floorObjectiveSystem(world);
    floor1EnemyDirectorSystem(world);
    questSystem(world);
    achievementSystem(world);
  }

  for (const sys of options.postSystems ?? []) {
    sys(world);
  }
}
