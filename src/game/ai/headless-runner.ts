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
import { Player, Health, createGameWorld, spawnPlayer } from '../../core/index.js';
import { createInputState } from '../../shared/input.js';
import { GAME } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';
import type { AIInputProvider, RunStats } from './types.js';
import { runSimulationStep, type SimulationOptions } from './simulation-step.js';

const logger = createLogger('game:headless-runner');

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
  const playerEid = spawnPlayer(world, {
    x: world.floorMap?.startPosition?.x ?? 400,
    y: world.floorMap?.startPosition?.y ?? 400,
  });

  world.state = 'playing';
  const inputState = createInputState();

  let frameCount = 0;
  let lastProgressFrame = 0;
  let outcome: RunStats['outcome'] = 'timeout';

  try {
    // Main simulation loop
    while (frameCount < mergedConfig.maxFrames) {
      // Check wall-clock timeout
      const elapsed = Date.now() - startTime;
      if (elapsed > mergedConfig.maxWallTimeMs) {
        outcome = 'timeout';
        break;
      }

      // AI decides input for this frame
      aiProvider.poll(inputState, world);

      // Run one simulation step
      runSimulationStep(world, inputState, GAME.DELTA_MS, config.simulationOptions);

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

      // Check for victory (Floor 10+ or other win condition)
      if (world.floor >= 10) {
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
          fps: fps.toFixed(0),
        });
        lastProgressFrame = frameCount;
      }
    }
  } catch (error) {
    outcome = 'error';
    logger.error('Headless run crashed', { error });

    const wallTimeMs = Date.now() - startTime;
    return {
      totalFrames: frameCount,
      wallTimeMs,
      gameTimeMs: world.elapsedMs,
      finalFloor: world.floor,
      finalScore: world.broadcastScore,
      outcome: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const wallTimeMs = Date.now() - startTime;
  const fps = (frameCount / wallTimeMs) * 1000;

  const stats: RunStats = {
    totalFrames: frameCount,
    wallTimeMs,
    gameTimeMs: world.elapsedMs,
    finalFloor: world.floor,
    finalScore: world.broadcastScore,
    outcome,
  };

  if (mergedConfig.debug || mergedConfig.progressInterval > 0) {
    logger.info('Headless run complete', {
      ...stats,
      fps: fps.toFixed(0),
    });
  }

  return stats;
}
