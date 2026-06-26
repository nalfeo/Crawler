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
import { type AIInputProvider, type RunStats, type LevelUpEvent } from './types.js';
import { AI_STATE_NAME, type SimEvent } from './event-log.js';
import { runSimulationStep, type SimulationOptions } from './simulation-step.js';
import { initializeFloor1Scenario, selectFloor1StarterWeapon } from '../index.js';
import {
  autoAllocateStatPoints,
  autoFloor1ProgressionSystem,
  autoNpcInteractionSystem,
} from './auto-progression.js';
import { computeFloorProgressScore } from './bt-ai-provider.js';
import { QuestProgressStallTracker, formatQuestStallReason } from './quest-stall.js';

const logger = createLogger('game:headless-runner');

/**
 * Reads `world.state` outside the run loop's control-flow narrowing.
 *
 * `runHeadless` throws unless `world.state === 'playing'` right after setup,
 * which makes TypeScript narrow `world.state` to the literal `'playing'` for the
 * rest of that function. The systems invoked each frame can flip it to
 * `'game_over'` (HP death or floor-collapse timeout), but TS cannot see those
 * opaque mutations. Reading it here, in a separate scope, restores the full
 * declared union so defeat detection type-checks honestly.
 */
function readRunState(world: GameWorld): GameWorld['state'] {
  return world.state;
}

// Floor 1 AI-driver auto-actions (NPC talk, boss-reward spell pick, shop
// prize/buy/equip, stair descend, stat allocation) live in ./auto-progression.ts
// so the headless runner and the in-browser AI-runner lab share identical
// AI-driver behavior. See that module for the spend-order / spell-pick rationale.

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
  /** Optional sink for structured telemetry events (event log). */
  recordEvent?: (event: SimEvent) => void;
  /** Frames between periodic sample events when recording (default 15). */
  eventSampleInterval?: number;
  /**
   * Force a specific starting weapon by ID (e.g. "sword", "bow", "baseball-bat").
   * When set, the runner finds the matching entry in the seed's starter choices
   * and selects it regardless of its shuffle position.  If the weapon is not
   * present in the pool the run throws immediately.
   */
  forceWeaponId?: string;
  /**
   * Frames of zero floor-progress (no quest objective tick, completion, or gold
   * gain) before the run is declared `'stalled'` and terminated early with a
   * quest-level diagnostic. Keys on quest progress, not on the AI reaching its
   * movement goals, so a knockback/kite deadlock or a "can't find the next NPC"
   * wander fast-fails with a clear reason instead of burning the whole budget.
   * Sized above the slowest legitimate inter-progress gap on winning seeds and
   * above the in-AI relocate cycle (now 200s on the 240×140 map) so it never
   * false-fails a healthy run. Set to 0 to disable. Default 21 600 (~360s at
   * 60 FPS).
   */
  questStallFrames?: number;
}

const DEFAULT_CONFIG: Required<
  Omit<HeadlessRunnerConfig, 'simulationOptions' | 'recordEvent' | 'forceWeaponId'>
> = {
  seed: 12345,
  maxFrames: 100_000, // ~27 min at 60 FPS
  maxWallTimeMs: 5 * 60 * 1000, // 5 minutes wall time
  progressInterval: 0,
  debug: false,
  eventSampleInterval: 15,
  questStallFrames: 21_600, // ~360s of frozen quest progress on the 240×140 map
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
  // This sets world.state = 'loadout'
  initializeFloor1Scenario(world, playerEid);

  // Select starter weapon: either the forced weapon ID or option index 0.
  let starterWeaponIndex = 0;
  const forceWeaponId = config.forceWeaponId;
  if (forceWeaponId !== undefined && world.floor1) {
    const idx = world.floor1.starterChoices.indexOf(forceWeaponId);
    if (idx === -1) {
      throw new Error(
        `forceWeaponId "${forceWeaponId}" not in starter choices for seed ${mergedConfig.seed}: [${world.floor1.starterChoices.join(', ')}]`,
      );
    }
    starterWeaponIndex = idx;
  }
  selectFloor1StarterWeapon(world, starterWeaponIndex);
  const startingWeapon: string =
    world.floor1?.selectedWeaponId ?? world.floor1?.starterChoices[starterWeaponIndex] ?? 'unknown';

  // Verify we transitioned to 'playing' state
  if (world.state !== 'playing') {
    throw new Error(`Failed to transition from loadout: state is ${world.state}`);
  }
  const inputState = createInputState();

  let frameCount = 0;
  let lastProgressFrame = 0;
  let outcome: RunStats['outcome'] = 'timeout';
  let stallReason: string | undefined;
  const stallTracker = new QuestProgressStallTracker(mergedConfig.questStallFrames);

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
  let damageDealt = 0;
  let damageTaken = 0;
  // Real damage measurement: track each enemy's HP frame-to-frame.
  const enemyHpById = new Map<number, number>();
  let questsAccepted = 0;
  let questsCompleted = 0;
  const questsFailed: string[] = [];
  let mainQuestAcceptedMs: number | null = null;
  let mainQuestCompletedMs: number | null = null;
  // General quest-log telemetry (floor-agnostic): tracks `world.questLog`, the
  // canonical quest system, independent of any floor-specific objective struct.
  // This is the source of truth for which quests were accepted/completed.
  const questLogAcceptedMs = new Map<string, number>();
  const questLogCompletedMs = new Map<string, number>();

  // NPC interaction tracking
  let lastNpcInteractionFrame = -1000;
  const NPC_INTERACTION_COOLDOWN = 30; // frames

  // Track initial state
  const playerMaxHealth = world.stores.health.max[playerEid] ?? 100;
  let lastHealthPercent = 1.0;

  // Event-log / telemetry state
  const recordEvent = config.recordEvent;
  const sampleInterval = Math.max(1, mergedConfig.eventSampleInterval);
  const navProvider = aiProvider as AIInputProvider & {
    getNavigationDebug?: () => { stuckFrames: number; pathWaypoints: readonly unknown[] };
  };
  let lastFrameX = world.stores.position.x[playerEid] ?? 0;
  let lastFrameY = world.stores.position.y[playerEid] ?? 0;
  let pathTravelAccum = 0;
  let lastSampleX = lastFrameX;
  let lastSampleY = lastFrameY;
  let lastLoggedState: number | null = null;

  const buildEvent = (
    type: SimEvent['type'],
    enemyEids: ArrayLike<number> & Iterable<number>,
    note?: string,
  ): SimEvent => {
    const decision = aiProvider.getDecision();
    const px = world.stores.position.x[playerEid] ?? 0;
    const py = world.stores.position.y[playerEid] ?? 0;
    let nearestEnemyDist: number | null = null;
    for (const enemy of enemyEids) {
      const ex = world.stores.position.x[enemy] ?? 0;
      const ey = world.stores.position.y[enemy] ?? 0;
      const dist = Math.hypot(ex - px, ey - py);
      if (nearestEnemyDist === null || dist < nearestEnemyDist) {
        nearestEnemyDist = dist;
      }
    }
    let targetDist: number | null = null;
    if (decision.targetX !== null && decision.targetY !== null) {
      targetDist = Math.hypot(decision.targetX - px, decision.targetY - py);
    }
    const nav = navProvider.getNavigationDebug?.();
    const netDisp = Math.hypot(px - lastSampleX, py - lastSampleY);
    return {
      type,
      frame: frameCount,
      gameMs: world.elapsedMs,
      px: Math.round(px),
      py: Math.round(py),
      state: AI_STATE_NAME[decision.state] ?? String(decision.state),
      reason: decision.reason,
      targetEid: decision.targetEid,
      targetDist: targetDist === null ? null : Math.round(targetDist),
      enemyCount: enemyEids.length,
      nearestEnemyDist: nearestEnemyDist === null ? null : Math.round(nearestEnemyDist),
      level: world.playerLevel?.level ?? 0,
      xp: world.playerLevel?.xp ?? 0,
      kills: totalKills,
      health: Math.round(world.stores.health.current[playerEid] ?? 0),
      stuckFrames: nav?.stuckFrames ?? 0,
      pathLen: nav?.pathWaypoints.length ?? 0,
      netDisp: Math.round(netDisp),
      pathTravel: Math.round(pathTravelAccum),
      ...(note ? { note } : {}),
    };
  };

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
        aiProvider,
        lastNpcInteractionFrame,
        frameCount,
        NPC_INTERACTION_COOLDOWN,
      );

      // Run one simulation step with Floor1 systems enabled
      runSimulationStep(world, inputState, GAME.DELTA_MS, {
        ...config.simulationOptions,
        enableFloor1: true,
      });
      autoFloor1ProgressionSystem(world, playerEid);
      autoAllocateStatPoints(world, playerEid);

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

      // Per-frame enemy snapshot (reused for combat, damage, and telemetry).
      const enemyEids = query(world.ecs, [Enemy]);
      const currentEnemyCount = enemyEids.length;

      // Real damage-dealt measurement via enemy HP deltas.
      const seenEnemies = new Set<number>();
      for (const enemy of enemyEids) {
        seenEnemies.add(enemy);
        const hp = world.stores.health.current[enemy] ?? 0;
        const prevHp = enemyHpById.get(enemy);
        if (prevHp !== undefined && hp < prevHp) {
          damageDealt += prevHp - hp;
        }
        enemyHpById.set(enemy, hp);
      }
      for (const [enemy, prevHp] of enemyHpById) {
        if (!seenEnemies.has(enemy)) {
          // Enemy despawned (killed): count remaining HP as the lethal blow.
          if (prevHp > 0) damageDealt += prevHp;
          enemyHpById.delete(enemy);
        }
      }

      // Movement accumulation for wiggle/stuck detection.
      const frameX = world.stores.position.x[playerEid] ?? lastFrameX;
      const frameY = world.stores.position.y[playerEid] ?? lastFrameY;
      pathTravelAccum += Math.hypot(frameX - lastFrameX, frameY - lastFrameY);
      lastFrameX = frameX;
      lastFrameY = frameY;

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
        recordEvent?.(buildEvent('levelup', enemyEids, `reached level ${currentLevel}`));
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
        if (recordEvent) {
          for (let k = 0; k < enemiesKilled; k += 1) {
            recordEvent(
              buildEvent('kill', enemyEids, `kill ${totalKills - enemiesKilled + k + 1}`),
            );
          }
        }
      }

      // 4. Quest tracking (basic - would need event system for full tracking)
      if (world.floor1) {
        const objective = world.floor1.objective;
        if (objective.questAccepted && mainQuestAcceptedMs === null) {
          mainQuestAcceptedMs = world.elapsedMs;
          questsAccepted++;
          recordEvent?.(buildEvent('quest', enemyEids, 'main quest accepted'));
        }
        if (objective.questCompleted && mainQuestCompletedMs === null) {
          mainQuestCompletedMs = world.elapsedMs;
          questsCompleted++;
          recordEvent?.(buildEvent('quest', enemyEids, 'main quest completed'));
        }
      }

      // General quest-log tracking — reads `world.questLog` (the canonical quest
      // system) rather than floor1-specific objective flags, so every floor's
      // quests are measured the same way. Emits an event the first time each
      // quest is seen and the first time it flips to `complete`.
      for (const [questId, questState] of world.questLog) {
        if (!questLogAcceptedMs.has(questId)) {
          questLogAcceptedMs.set(questId, world.elapsedMs);
          recordEvent?.(buildEvent('quest', enemyEids, `questlog accepted: ${questId}`));
        }
        if (questState.status === 'complete' && !questLogCompletedMs.has(questId)) {
          questLogCompletedMs.set(questId, world.elapsedMs);
          recordEvent?.(buildEvent('quest', enemyEids, `questlog completed: ${questId}`));
        }
      }

      // Telemetry: state-change annotations + periodic samples.
      if (recordEvent) {
        const decisionState = aiProvider.getDecision().state;
        if (decisionState !== lastLoggedState) {
          recordEvent(
            buildEvent(
              'state',
              enemyEids,
              `state -> ${AI_STATE_NAME[decisionState] ?? decisionState}`,
            ),
          );
          lastLoggedState = decisionState;
        }
        if (frameCount % sampleInterval === 0) {
          recordEvent(buildEvent('sample', enemyEids));
          // Reset per-sample movement window.
          pathTravelAccum = 0;
          lastSampleX = world.stores.position.x[playerEid] ?? lastSampleX;
          lastSampleY = world.stores.position.y[playerEid] ?? lastSampleY;
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

      // Check for defeat. The floor sets `world.state = 'game_over'` either when
      // the player's HP hits zero (healthSystem) or when the in-game
      // floor-collapse deadline expires before the staircase is discovered
      // (floor1ObjectiveTick -> failReason 'stair_timeout'). Without this guard
      // the loop spins uselessly until maxFrames while the simulation is frozen,
      // misreporting the run and wasting thousands of frames.
      if (readRunState(world) === 'game_over') {
        outcome = world.floor1?.failReason === 'stair_timeout' ? 'timeout' : 'death';
        break;
      }

      // Quest-progress stall watchdog. Fast-fail a run whose quest log has frozen
      // (no objective tick / completion / gold gain) for longer than the budget,
      // emitting a quest-level diagnostic instead of silently burning the full
      // wall/frame budget. Keyed on quest progress rather than goal-reaching so a
      // deadlock or unreachable-NPC wander surfaces clearly. The in-AI watchdog
      // relocates first (~100s); this only fires if that fails to recover.
      if (
        stallTracker.update(
          computeFloorProgressScore(world.questLog.values(), world.playerGold),
          frameCount,
        )
      ) {
        outcome = 'stalled';
        stallReason = formatQuestStallReason(
          world.questLog.values(),
          stallTracker.framesSinceProgress(frameCount),
          GAME.DELTA_MS,
        );
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
        firstQuestCompletedMs:
          questLogCompletedMs.size > 0 ? Math.min(...questLogCompletedMs.values()) : null,
        questLogAccepts: Object.fromEntries(questLogAcceptedMs),
        questLogCompletions: Object.fromEntries(questLogCompletedMs),
      },
      finalLevel: world.playerLevel?.level ?? 0,
      totalXp: world.playerLevel?.xp ?? 0,
      totalGold: world.playerGold,
      startingWeapon,
    };
  }

  const wallTimeMs = Date.now() - startTime;
  const fps = (frameCount / wallTimeMs) * 1000;
  const finalScore = world.stores.broadcastScore?.current[playerEid] ?? 0;
  const playerHealth = world.stores.health.current[playerEid] ?? 0;
  const finalHealthPercent = playerHealth / playerMaxHealth;

  // Attribute kills by archetype from the Floor 1 objective tally (accurate).
  if (world.floor1) {
    killsByType.rat = world.floor1.objective.ratsKilled;
    killsByType.slime = world.floor1.objective.slimesKilled;
  }

  const stats: RunStats = {
    totalFrames: frameCount,
    wallTimeMs,
    gameTimeMs: world.elapsedMs,
    finalFloor: world.floor,
    finalScore,
    outcome,
    ...(stallReason ? { stallReason } : {}),
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
      firstQuestCompletedMs:
        questLogCompletedMs.size > 0 ? Math.min(...questLogCompletedMs.values()) : null,
      questLogAccepts: Object.fromEntries(questLogAcceptedMs),
      questLogCompletions: Object.fromEntries(questLogCompletedMs),
    },
    finalLevel: world.playerLevel?.level ?? 0,
    totalXp: world.playerLevel?.xp ?? 0,
    totalGold: world.playerGold,
    startingWeapon,
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
