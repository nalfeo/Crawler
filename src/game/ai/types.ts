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
  /** How far to scan for targets (in pixels) */
  scanRadius?: number;
  /** How far to maintain from ranged enemies (in pixels) */
  rangedSafeDistance?: number;
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
  outcome: 'victory' | 'death' | 'timeout' | 'error';
  /** Error message if outcome is 'error' */
  error?: string;

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
}
