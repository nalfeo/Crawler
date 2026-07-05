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
  familyRelationshipSystem,
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
  familyFeudSystem,
  levelSystem,
  skillSystem,
  abilitySystem,
  achievementSystem,
  spawnerArenaSystem,
  spawnerSystem,
  emergentEventSystem,
} from '../index.js';
import { floor2VictorySystem } from '../floor2Scenario.js';
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
  //
  // statusEffectSystem runs AFTER both speed read-sites (playerInputSystem above,
  // enemyAISystem here) so player and enemy effective-speed folds observe the SAME
  // pre-expiry effect set on every frame — no 1-frame expiry skew between them —
  // and still before movement/damage/health so a HoT tick can't mask a same-frame
  // death. It reads speed via fold-in (never mutates it), so ordering vs the AI
  // read is a pure timing choice, resolved here in favour of symmetry.
  statsSystem(world);
  statSystem(world);
  manaSystem(world);
  // Drain queued faction-relation deltas. Always-safe (Floor 1 empties queue
  // to a near-noop); Floor-2-onwards this feeds band-driven AI (Slice 3).
  familyRelationshipSystem(world);
  // Floor 2 Slice 5: run dynamic win evaluator every tick in headless too.
  floor2VictorySystem(world);
  // Emergent event scheduler runs immediately after the drain — a threshold
  // event that flips a band this frame can queue its own follow-on deltas
  // for next frame's drain (Slice 6).
  emergentEventSystem(world);
  if (options.enableFloor1 && world.floor1) {
    floor1PlayerStatSystem(world);
  }
  // Floor 2 Slice 3: band-driven AI prepass. Runs AFTER familyRelationshipSystem
  // (so it observes this frame's post-adjust relations) and BEFORE enemyAISystem
  // (so it can plant a virtual target + hate speed ramp the AI will consume).
  // Always-safe on Floor 1 — no mobs have FamilyMembership, so the system is a
  // near-noop (retaliation cursor advance only).
  familyFeudSystem(world);
  enemyAISystem(world);
  statusEffectSystem(world);
  // Runs immediately before spawnerSystem in both pipelines so fence tile
  // mutations (open-fence arena) are visible when spawnerSystem picks child
  // spawn positions this same tick. See `src/game/spawners/spawnerArenaSystem.ts`.
  spawnerArenaSystem(world);
  spawnerSystem(world);

  movementSystem(world);
  returningProjectileSystem(world);
  weaponSystem(world);
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
  if (!options.enableFloor1 && world.floorObjectiveTick) {
    world.floorObjectiveTick(world);
  }

  for (const sys of options.postSystems ?? []) {
    sys(world);
  }
}
