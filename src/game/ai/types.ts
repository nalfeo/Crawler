/**
 * AI player types and interfaces.
 *
 * Traditional rule-based AI that plays through simulated InputState.
 */
import type { GameWorld } from '../../core/world.js';
import type { InputState } from '../../shared/input.js';

/**
 * AI behavioral state machine states.
 */
export const AIState = {
  /** Wandering, exploring, looking for objectives */
  EXPLORE: 0,
  /** Moving toward and attacking enemies */
  ENGAGE: 1,
  /** Low health, retreating to safety */
  RETREAT: 2,
  /** Collecting XP gems and loot */
  COLLECT: 3,
  /** Interacting with NPCs or stairs */
  INTERACT: 4,
} as const;

export type AIStateValue = (typeof AIState)[keyof typeof AIState];

/** Telemetry-only state labels that refine the coarse gameplay state. */
export const AIDecisionDebugState = {
  /** EXPLORE fallback caused by a suppressed fixed-position progress objective. */
  SUPPRESSED_PROGRESS_NAV: 'suppressedProgressNav',
} as const;

export type AIDecisionDebugStateValue =
  (typeof AIDecisionDebugState)[keyof typeof AIDecisionDebugState];

/** Existing watchdogs/suppression windows that can suppress progress navigation. */
export const AIProgressSuppressionSource = {
  EXPLORE_DWELL_FIXED_POSITION_TARGET: 'exploreDwellFixedPositionTarget',
  EXPLORE_DWELL_FRONTIER_TARGET: 'exploreDwellFrontierTarget',
  QUEST_PROGRESS_DWELL_WATCHDOG: 'questProgressDwellWatchdog',
  PROGRESS_GOAL_SUPPRESSION_WINDOW: 'progressGoalSuppressionWindow',
} as const;

export type AIProgressSuppressionSourceValue =
  (typeof AIProgressSuppressionSource)[keyof typeof AIProgressSuppressionSource];

/** Typed debug payload for EXPLORE samples that are really suppressed progress nav. */
export interface AISuppressedProgressNavDebug {
  state: typeof AIDecisionDebugState.SUPPRESSED_PROGRESS_NAV;
  reason: 'progressGoalSuppressed';
  source: AIProgressSuppressionSourceValue;
  blockedTargetReason: string;
  suppressedUntilFrame: number;
  remainingFrames: number;
}

export type AIDecisionDebug = AISuppressedProgressNavDebug;

/**
 * AI decision context - what the AI is currently thinking about.
 */
export interface AIDecision {
  /** Current behavioral state */
  state: AIStateValue;
  /** Target entity ID (enemy, XP gem, NPC) */
  targetEid: number | null;
  /** Target position in world coordinates */
  targetX: number | null;
  targetY: number | null;
  /** Human-readable reason for current decision */
  reason: string;
  /** Telemetry-only refinement; never drives gameplay behavior. */
  debug: AIDecisionDebug | null;
}

/**
 * AI configuration options.
 */
export interface AIConfig {
  /** RNG seed for deterministic behavior (uses world.rng if not provided) */
  seed?: number;
  /** Aggression level: 0=very passive, 1=balanced, 2=very aggressive */
  aggression?: number;
  /** Retreat threshold: health percentage to trigger retreat (0-1) */
  retreatThreshold?: number;
  /**
   * How close (in feet) a living enemy must be for low health to trigger a
   * retreat. Low health while no enemy is within this radius must NOT cause a
   * retreat — there is no passive health regen, so a safe low-health AI would
   * otherwise deadlock forever instead of finishing non-combat objectives.
   */
  retreatDangerRadius?: number;
  /** How far to scan for targets (in feet) */
  scanRadius?: number;
  /** How far to maintain from ranged enemies (in feet) */
  rangedSafeDistance?: number;
  /**
   * Radius (ft) within which the opportunistic collect layer pulls the player
   * toward nearby loot regardless of the current Track A movement goal.
   * Also used for path-waypoint sweep (loot within this radius of any waypoint).
   */
  opportunisticGrabRadius?: number;
  /**
   * Weight of the dodge vector injected by the opportunistic dodge layer.
   * Blended additively with the Track A movement vector before smoothing.
   * 0 = no dodge, 1 = full dodge override.
   */
  dodgeWeight?: number;
  /**
   * Weight of the opportunistic loot-collect pull vector. Blended additively
   * with the Track A movement vector before smoothing so the player curves into
   * a *slight detour* toward loot that lies within 5 ft of its forward path (see
   * the path-corridor gate in `OpportunisticCollect`). 0 = no detour, 1 = full
   * override.
   */
  collectPullWeight?: number;
  /**
   * Weight of the opportunistic enemy-farm pull vector (drift toward the nearest
   * enemy during genuine idle wander). Kept separate from {@link collectPullWeight}
   * and defaulting to 0 so re-enabling loot detours never silently re-enables
   * enemy seeking — the latter biases the AI into enemy-dense zones and can blow
   * the floor-clear time budget. Validate additional headless seeds before
   * setting > 0.
   */
  farmPullWeight?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * AI input provider interface.
 * Reads GameWorld state and outputs simulated InputState.
 */
export interface AIInputProvider {
  /**
   * Generate input for the current frame based on world state.
   * @param state - InputState to populate
   * @param world - Current game world
   */
  poll(state: InputState, world: GameWorld): void;

  /**
   * Get the AI's current decision for debugging/visualization.
   */
  getDecision(): AIDecision;

  /**
   * Reset AI state (useful for new floors or restarts).
   */
  reset(): void;
}

/**
 * Level-up event for tracking progression pacing.
 */
export interface LevelUpEvent {
  /** Level reached */
  level: number;
  /** Game time when level-up occurred (ms) */
  gameTimeMs: number;
  /** Frame count when level-up occurred */
  frame: number;
}

/**
 * Combat engagement tracking.
 */
export interface CombatMetrics {
  /** Total enemies killed */
  totalKills: number;
  /** Kills broken down by enemy type */
  killsByType: Record<string, number>;
  /** Total time spent in combat (ms) */
  combatTimeMs: number;
  /** Number of distinct combat engagements */
  engagementCount: number;
  /** Total damage dealt */
  damageDealt: number;
  /** Total damage taken */
  damageTaken: number;
}

/**
 * Health tracking for difficulty assessment.
 */
export interface HealthMetrics {
  /** Minimum health percentage reached (0-1) */
  minHealthPercent: number;
  /** Number of times health dropped below 20% */
  closeCallCount: number;
  /** Number of times health dropped below 50% */
  lowHealthCount: number;
  /** Final health when run ended */
  finalHealthPercent: number;
}

/**
 * Quest progression tracking.
 */
export interface QuestMetrics {
  /** Quests accepted during run */
  questsAccepted: number;
  /** Quests completed during run */
  questsCompleted: number;
  /** Quest IDs that were failed */
  questsFailed: string[];
  /** Time when main quest was accepted (ms) */
  mainQuestAcceptedMs: number | null;
  /** Time when main quest was completed (ms) */
  mainQuestCompletedMs: number | null;
  /**
   * Time (ms) when the first quest-log quest completed. Floor-agnostic: read
   * from `world.questLog` (the canonical quest system) rather than any
   * floor-specific objective struct. This is the headline "first quest" metric.
   */
  firstQuestCompletedMs: number | null;
  /** questId → accept time (ms) for every quest observed in `world.questLog`. */
  questLogAccepts: Record<string, number>;
  /** questId → completion time (ms) for every quest observed in `world.questLog`. */
  questLogCompletions: Record<string, number>;
}

/**
 * Run statistics for performance tracking.
 */
export interface RunStats {
  /** Total simulated frames */
  totalFrames: number;
  /** Wall-clock time elapsed (ms) */
  wallTimeMs: number;
  /** Simulated game time (ms) */
  gameTimeMs: number;
  /** Final floor reached */
  finalFloor: number;
  /** Final score */
  finalScore: number;
  /** Run outcome */
  outcome: 'victory' | 'death' | 'timeout' | 'stalled' | 'error';
  /** Error message if outcome is 'error' */
  error?: string;
  /**
   * Human-readable explanation when `outcome` is `'stalled'`: which quests had
   * completed and which the run was waiting on when floor progress froze.
   */
  stallReason?: string;

  // Detailed metrics for balance analysis
  /** Level-up events with timestamps */
  levelUps: LevelUpEvent[];
  /** Combat engagement metrics */
  combat: CombatMetrics;
  /** Health tracking */
  health: HealthMetrics;
  /** Quest progression */
  quests: QuestMetrics;
  /** Final player level reached */
  finalLevel: number;
  /** Total XP earned */
  totalXp: number;
  /** Gold held by the player at run end */
  totalGold: number;
  /** ID of the starting weapon selected for this run */
  startingWeapon: string;
}
