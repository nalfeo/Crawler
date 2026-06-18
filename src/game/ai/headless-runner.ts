/**
 * Headless game runner - runs pure ECS simulation at maximum speed.
 *
 * No Phaser, no DOM, no rendering. Perfect for:
 * - AI training and testing
 * - Performance benchmarking
 * - Batch simulation runs
 * - CI regression tests
 */
import { query } from 'bitecs';
import {
  Player,
  Health,
  createGameWorld,
  spawnPlayer,
  Enemy,
  type GameWorld,
} from '../../core/index.js';
import { createInputState } from '../../shared/input.js';
import { GAME } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';
import type { AIInputProvider, RunStats, LevelUpEvent } from './types.js';
import { runSimulationStep, type SimulationOptions } from './simulation-step.js';
import {
  meetTutorialGoon,
  meetShopkeeper,
  meetSpellQuestGiver,
  initializeFloor1Scenario,
} from '../index.js';
import { setActiveWeapon } from '../weaponSystem.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';

const logger = createLogger('game:headless-runner');

/**
 * Headless-compatible NPC interaction system.
 * Automatically meets NPCs when the player is nearby (simulates pressing E).
 */
function autoNpcInteractionSystem(
  world: GameWorld,
  _playerEid: number,
  lastInteractionFrame: number,
  currentFrame: number,
  cooldown: number,
): number {
  if (currentFrame - lastInteractionFrame < cooldown) {
    return lastInteractionFrame;
  }

  // Check if any NPC has nearbyPlayer flag set
  for (const [_eid, instance] of world.npcs.entries()) {
    if (instance.nearbyPlayer) {
      // Simulate pressing E to interact
      if (instance.defId === 'tutorial-goon') {
        meetTutorialGoon(world);
        return currentFrame;
      } else if (instance.defId === 'shopkeeper') {
        meetShopkeeper(world);
        return currentFrame;
      } else if (instance.defId === 'spell-quest-giver') {
        meetSpellQuestGiver(world);
        return currentFrame;
      }
    }
  }

  return lastInteractionFrame;
}

export interface HeadlessRunnerConfig {
  /** Random seed for deterministic runs */
  seed: number;
  /** Maximum frames to simulate (safety limit) */
  maxFrames?: number;
  /** Maximum wall-clock time in milliseconds */
  maxWallTimeMs?: number;
  /** Report progress every N frames (0 = never) */
  progressInterval?: number;
  /** Custom simulation systems */
  simulationOptions?: SimulationOptions;
  /** Enable verbose logging */
  debug?: boolean;
}

const DEFAULT_CONFIG: Required<Omit<HeadlessRunnerConfig, 'simulationOptions'>> = {
  seed: 12345,
  maxFrames: 100_000, // ~27 min at 60 FPS
  maxWallTimeMs: 5 * 60 * 1000, // 5 minutes wall time
  progressInterval: 0,
  debug: false,
};

/**
 * Run a complete game simulation headlessly with an AI player.
 *
 * @param aiProvider - AI input provider
 * @param config - Runner configuration
 * @returns Run statistics
 */
export async function runHeadless(
  aiProvider: AIInputProvider,
  config: HeadlessRunnerConfig,
): Promise<RunStats> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  if (mergedConfig.debug) {
    logger.info('Starting headless run', mergedConfig);
  }

  // Create world and spawn player
  const world = createGameWorld({ seed: mergedConfig.seed });
  const playerEid = spawnPlayer(world, 400, 400);

  // Initialize Floor1 scenario (generates map, sets up objectives, NPCs, etc.)
  initializeFloor1Scenario(world, playerEid);

  // Auto-equip first available starter weapon for headless mode
  if (world.floor1 && world.floor1.starterWeaponPool.length > 0) {
    const firstWeaponId = world.floor1.starterWeaponPool[0];
    if (firstWeaponId) {
      const weaponDef = getWeaponDef(firstWeaponId);
      if (weaponDef) {
        setActiveWeapon(world, weaponDef);
      }
    }
  }

  world.state = 'playing';
  const inputState = createInputState();

  let frameCount = 0;
  let lastProgressFrame = 0;
  let outcome: RunStats['outcome'] = 'timeout';

  // Metric trackers
  const levelUps: LevelUpEvent[] = [];
  let previousLevel = 0;
  const killsByType: Record<string, number> = {};
  let totalKills = 0;
  let minHealthPercent = 1.0;
  let closeCallCount = 0;
  let lowHealthCount = 0;
  let combatTimeMs = 0;
  let engagementCount = 0;
  let inCombat = false;
  let combatStartFrame = 0;
  const damageDealt = 0;
  let damageTaken = 0;
  let questsAccepted = 0;
  let questsCompleted = 0;
  const questsFailed: string[] = [];
  let mainQuestAcceptedMs: number | null = null;
  let mainQuestCompletedMs: number | null = null;

  // NPC interaction tracking
  let lastNpcInteractionFrame = -1000;
  const NPC_INTERACTION_COOLDOWN = 30; // frames

  // Track initial state
  const playerMaxHealth = world.stores.health.max[playerEid] ?? 100;
  let lastHealthPercent = 1.0;

  try {
    // Main simulation loop
    while (frameCount < mergedConfig.maxFrames) {
      // Check wall-clock timeout
      const elapsed = Date.now() - startTime;
      if (elapsed > mergedConfig.maxWallTimeMs) {
        outcome = 'timeout';
        break;
      }

      // Track state before frame
      const previousEnemyCount = query(world.ecs, [Enemy]).length;
      const previousPlayerHealth = world.stores.health.current[playerEid] ?? 0;

      // AI decides input for this frame
      aiProvider.poll(inputState, world);

      // Auto-interact with nearby NPCs (simulates pressing E)
      lastNpcInteractionFrame = autoNpcInteractionSystem(
        world,
        playerEid,
        lastNpcInteractionFrame,
        frameCount,
        NPC_INTERACTION_COOLDOWN,
      );

      // Run one simulation step with Floor1 systems enabled
      runSimulationStep(world, inputState, GAME.DELTA_MS, {
        ...config.simulationOptions,
        enableFloor1: true,
      });

      frameCount++;

      // Check win/loss conditions
      const playerEntities = query(world.ecs, [Player, Health]);
      if (playerEntities.length === 0 || playerEntities[0] === undefined) {
        outcome = 'death';
        break;
      }

      const playerHealth = world.stores.health.current[playerEid] ?? 0;
      if (playerHealth <= 0) {
        outcome = 'death';
        break;
      }

      // Track metrics after frame
      // 1. Level-ups
      const currentLevel = world.playerLevel?.level ?? 0;
      if (currentLevel > previousLevel) {
        levelUps.push({
          level: currentLevel,
          gameTimeMs: world.elapsedMs,
          frame: frameCount,
        });
        previousLevel = currentLevel;
      }

      // 2. Health tracking
      const currentHealthPercent = playerHealth / playerMaxHealth;
      if (currentHealthPercent < minHealthPercent) {
        minHealthPercent = currentHealthPercent;
      }
      if (currentHealthPercent < 0.2 && lastHealthPercent >= 0.2) {
        closeCallCount++;
      }
      if (currentHealthPercent < 0.5 && lastHealthPercent >= 0.5) {
        lowHealthCount++;
      }
      lastHealthPercent = currentHealthPercent;

      // Track damage taken
      if (previousPlayerHealth > playerHealth) {
        damageTaken += previousPlayerHealth - playerHealth;
      }

      // 3. Combat tracking
      const currentEnemyCount = query(world.ecs, [Enemy]).length;
      const enemiesNearby = currentEnemyCount > 0;

      if (enemiesNearby && !inCombat) {
        // Combat started
        inCombat = true;
        combatStartFrame = frameCount;
        engagementCount++;
      } else if (!enemiesNearby && inCombat) {
        // Combat ended
        inCombat = false;
        const combatDurationFrames = frameCount - combatStartFrame;
        combatTimeMs += combatDurationFrames * GAME.DELTA_MS;
      }

      // Track kills (enemy count decreased)
      if (currentEnemyCount < previousEnemyCount) {
        const enemiesKilled = previousEnemyCount - currentEnemyCount;
        totalKills += enemiesKilled;
        // For now, we don't have enemy type in this loop - would need event system
        // This is simplified tracking
      }

      // 4. Quest tracking (basic - would need event system for full tracking)
      if (world.floor1) {
        const objective = world.floor1.objective;
        if (objective.questAccepted && mainQuestAcceptedMs === null) {
          mainQuestAcceptedMs = world.elapsedMs;
          questsAccepted++;
        }
        if (objective.questCompleted && mainQuestCompletedMs === null) {
          mainQuestCompletedMs = world.elapsedMs;
          questsCompleted++;
        }
      }

      // Check for victory (Floor 10+ or Floor 1 completion)
      if (world.floor >= 10) {
        outcome = 'victory';
        break;
      }
      if (world.floor1?.runSummary?.outcome === 'cleared_floor') {
        outcome = 'victory';
        break;
      }

      // Progress reporting
      if (
        mergedConfig.progressInterval > 0 &&
        frameCount - lastProgressFrame >= mergedConfig.progressInterval
      ) {
        const wallTime = Date.now() - startTime;
        const fps = (frameCount / wallTime) * 1000;
        logger.info('Progress', {
          frame: frameCount,
          floor: world.floor,
          health: playerHealth,
          level: currentLevel,
          kills: totalKills,
          fps: fps.toFixed(0),
        });
        lastProgressFrame = frameCount;
      }
    }

    // If still in combat at end, add remaining time
    if (inCombat) {
      const combatDurationFrames = frameCount - combatStartFrame;
      combatTimeMs += combatDurationFrames * GAME.DELTA_MS;
    }
  } catch (error) {
    logger.error('Headless run crashed', { error });

    const wallTimeMs = Date.now() - startTime;
    const finalScore = world.stores.broadcastScore?.current[playerEid] ?? 0;
    const playerHealth = world.stores.health.current[playerEid] ?? 0;
    const currentHealthPercent = playerHealth / playerMaxHealth;

    return {
      totalFrames: frameCount,
      wallTimeMs,
      gameTimeMs: world.elapsedMs,
      finalFloor: world.floor,
      finalScore,
      outcome: 'error',
      error: error instanceof Error ? error.message : String(error),
      levelUps,
      combat: {
        totalKills,
        killsByType,
        combatTimeMs,
        engagementCount,
        damageDealt,
        damageTaken,
      },
      health: {
        minHealthPercent,
        closeCallCount,
        lowHealthCount,
        finalHealthPercent: currentHealthPercent,
      },
      quests: {
        questsAccepted,
        questsCompleted,
        questsFailed,
        mainQuestAcceptedMs,
        mainQuestCompletedMs,
      },
      finalLevel: world.playerLevel?.level ?? 0,
      totalXp: world.playerLevel?.xp ?? 0,
    };
  }

  const wallTimeMs = Date.now() - startTime;
  const fps = (frameCount / wallTimeMs) * 1000;
  const finalScore = world.stores.broadcastScore?.current[playerEid] ?? 0;
  const playerHealth = world.stores.health.current[playerEid] ?? 0;
  const finalHealthPercent = playerHealth / playerMaxHealth;

  const stats: RunStats = {
    totalFrames: frameCount,
    wallTimeMs,
    gameTimeMs: world.elapsedMs,
    finalFloor: world.floor,
    finalScore,
    outcome,
    levelUps,
    combat: {
      totalKills,
      killsByType,
      combatTimeMs,
      engagementCount,
      damageDealt,
      damageTaken,
    },
    health: {
      minHealthPercent,
      closeCallCount,
      lowHealthCount,
      finalHealthPercent,
    },
    quests: {
      questsAccepted,
      questsCompleted,
      questsFailed,
      mainQuestAcceptedMs,
      mainQuestCompletedMs,
    },
    finalLevel: world.playerLevel?.level ?? 0,
    totalXp: world.playerLevel?.xp ?? 0,
  };

  if (mergedConfig.debug || mergedConfig.progressInterval > 0) {
    logger.info('Headless run complete', {
      ...stats,
      fps: fps.toFixed(0),
      combatTimePercent: ((combatTimeMs / world.elapsedMs) * 100).toFixed(1),
    });
  }

  return stats;
}
