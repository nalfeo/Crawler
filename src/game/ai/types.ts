/**
 * AI player types and interfaces.
 *
 * Traditional rule-based AI that plays through simulated InputState.
 */
import type { GameWorld } from '../../core/world.js';
import type { WeaponTelemetrySummary } from '../../core/weapon-telemetry.js';
import type { InputState } from '../../shared/input.js';
import type { RunPlanSegmentPhase } from './run-planner.js';

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
 * A/B axis 1 — how the AI turns a Track A movement goal into a heading.
 *
 * Promoted winner from the 2026-07-21 AI Sweep (294/300 vs 286/300):
 * `RISK_REWARD_FUSED` is the sole current member. Additional arms may be added
 * for future floor tuning.
 */
export const AIPathingMode = {
  /**
   * Danger/reward-fused grid pathing. Scores candidate headings by objective
   * progress, reward pull, and sampled overlap-danger so the AI prefers low-risk
   * seams under enemy pressure, then executes through grid travel steering.
   * Promoted as the DEFAULT from the 2026-07-21 AI Sweep.
   */
  RISK_REWARD_FUSED: 'riskRewardFused',
} as const;
export type AIPathingModeValue = (typeof AIPathingMode)[keyof typeof AIPathingMode];

/**
 * A/B axis 2 — how the AI decides which Track A goal is eligible.
 *
 * `LEGACY` is the sole current member (fixed-priority ladder, time-blind).
 * Additional arms may be added for future floor tuning.
 */
export const AIDecisionMode = {
  /** Fixed-priority Track A ladder, time-blind. The 2026-07-21 AI Sweep winner. */
  LEGACY: 'legacy',
} as const;
export type AIDecisionModeValue = (typeof AIDecisionMode)[keyof typeof AIDecisionMode];

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
  criticalChainPhase: RunPlanSegmentPhase;
  blockedTargetReason: string;
  suppressedUntilFrame: number;
  remainingFrames: number;
}

export type AIDecisionDebug = AISuppressedProgressNavDebug;

export const AINpcInteractionAction = {
  GENERIC_INTERACTION: 'generic-interaction',
  MEET_BROKER_INTRO: 'meet-broker-intro',
  ACCEPT_TUTORIAL_QUEST: 'accept-tutorial-quest',
  MEET_SHOPKEEPER: 'meet-shopkeeper',
  RETURN_SHOPKEEPER_PRIZE: 'return-shopkeeper-prize',
  BUY_SHOPKEEPER_EQUIPMENT: 'buy-shopkeeper-equipment',
  ACCEPT_SPELL_QUEST: 'accept-spell-quest',
  CLAIM_SPELL_REWARD: 'claim-spell-reward',
} as const;

export type AINpcInteractionActionValue =
  (typeof AINpcInteractionAction)[keyof typeof AINpcInteractionAction];

/** Explicit NPC interaction intent carried through progress decisions. */
export interface AINpcInteractionIntent {
  npcEid: number;
  action: AINpcInteractionActionValue;
  /**
   * True when the AI is still in EXPLORE because it is walking to a reachable
   * interaction anchor for this NPC, so bounded auto-interaction is allowed.
   */
  allowWhileExploring: boolean;
}

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
  /** Structured NPC interaction intent for the current target, if any. */
  npcInteraction: AINpcInteractionIntent | null;
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
   * so loot-detour tuning never silently changes enemy seeking. Defaults to 0.12;
   * higher values bias the AI into enemy-dense zones and can blow the floor-clear
   * time budget. Validate additional headless seeds before setting higher values.
   */
  farmPullWeight?: number;
  /**
   * A/B axis 1: how a Track A goal becomes a heading. Defaults to
   * {@link AIPathingMode.RISK_REWARD_FUSED} — the 2026-07-21 AI Sweep winner
   * (294/300 vs 286/300).
   */
  pathingMode?: AIPathingModeValue;
  /**
   * A/B axis 2: how Track A goal eligibility is decided. Defaults to
   * {@link AIDecisionMode.LEGACY} — fixed-priority Track A ladder, time-blind.
   */
  decisionMode?: AIDecisionModeValue;
  /** Enable debug logging */
  debug?: boolean;
}

/** Deterministic behavioral cohorts used by the fun evaluator. */
export type PlayerPersona = 'new_player' | 'experienced_player' | 'min_max_cheeser' | 'explorer';

/**
 * AI input provider interface.
 * Reads GameWorld state and outputs simulated InputState.
 */
export interface AIInputProvider {
  /**
   * Configure the raw simulated-time deadline derived from the runner's frame
   * budget. Providers without time-aware planning may omit this capability.
   */
  configurePlanningDeadlineMs?(deadlineMs: number | null): void;

  /**
   * Resolve the provider's effective Floor 1 planning deadline. Used by the
   * headless auto-progression driver to share the provider's exact budget.
   */
  resolveFloor1PlanningDeadlineMs?(objectiveDeadlineMs: number): number;

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
  /** Actual post-mitigation player damage grouped by stable attacker identity. */
  damageTakenBySource: Record<string, number>;
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
 * AI decision-state rollups captured during a headless run.
 */
export interface AIDecisionTelemetryMetrics {
  /** Number of AI poll frames spent in each emitted decision-state label. */
  decisionStateCounts: Record<string, number>;
  /** Simulated time spent in each emitted decision-state label. */
  decisionStateMs: Record<string, number>;
  /** Number of poll frames classified as suppressed progress navigation. */
  suppressedProgressNavCount: number;
  /** Simulated time classified as suppressed progress navigation. */
  suppressedProgressNavMs: number;
}

/**
 * Spawner Battle-Arena rollup — captured once at the end of a headless run so
 * the win-rate gate can assert every reachable spawner reached the resolved
 * terminal state (`arenaState === 2`). Populated by `runHeadless`; if a run
 * generates no spawners the counts are all zero. See ADR "Spawner Battle
 * Arena" and `spawnerArenaSystem`.
 */
export interface SpawnerArenaMetrics {
  /** Total spawner entities present at run end (includes resolved/dead ones). */
  total: number;
  /** Count that were triggered by the player (arenaState ≥ 1). */
  triggered: number;
  /** Count that reached the terminal resolved state (arenaState === 2). */
  resolved: number;
  /**
   * Count of spawners that raised a *real* barrier at some point in the run —
   * either a fence snapshot (open-fence arenas) or one or more locked doors
   * (sealed-room arenas). Derived from the persistent `spawnerArenaEverArmed`
   * latch, which is set ONLY when a non-empty barrier is stored and is never
   * cleared on resolve. An IDLE→RESOLVED short-circuit (spawner killed before
   * it ever armed) is deliberately excluded — it never trapped the player.
   *
   * This is the correct denominator for "did the AI resolve arenas that
   * actually trapped it?" — a triggered arena whose barrier code path was a
   * no-op (empty fence ring, roomless spawner, no matching door entity) never
   * traps the AI, so asking the AI to resolve it would be a false requirement.
   */
  barrierArmed: number;
  /**
   * Count of arenas that both armed a real barrier AND reached the terminal
   * resolved state (`arenaState === 2`). This — not `resolved` — is the correct
   * numerator for the ADR-0045 resolved/armed gate: `resolved` also includes
   * IDLE→RESOLVED short-circuits that never armed, which would push the ratio
   * above 1.0 and mask a genuine "AI walked past an armed barrier" miss.
   */
  resolvedArmed: number;
  /** Sum of `bankedXp` across all spawners at run end. */
  bankedXpTotal: number;
}

/** Lifecycle evidence for one named production Floor 1 boss encounter. */
export interface Floor1BossEncounterMetrics {
  /** Boss entity captured when the encounter first started. */
  bossEid: number | null;
  /** Whether the production encounter started. */
  encounterStarted: boolean;
  /** Simulation frame when the encounter first started. */
  encounterStartedFrame: number | null;
  /** Simulated time when the encounter first started. */
  encounterStartedMs: number | null;
  /** Player level when the encounter first started. */
  playerLevelAtStart: number | null;
  /** Player health fraction when the encounter first started. */
  playerHealthFractionAtStart: number | null;
  /** Whether the production encounter was defeated. */
  encounterDefeated: boolean;
  /** Simulation frame when the encounter was first defeated. */
  encounterDefeatedFrame: number | null;
  /** Simulated time when the encounter was first defeated. */
  encounterDefeatedMs: number | null;
}

/** Named Floor 1 boss lifecycle evidence captured by the headless runner. */
export interface Floor1BossProgressionMetrics {
  encounters: Record<string, Floor1BossEncounterMetrics>;
}

/** Per-family evidence for production Floor 2 progression. */
export interface Floor2FamilyProgressMetrics {
  /** Player-attributed non-boss kills recorded by the production objective tick. */
  trashKills: number;
  /** Kill count on the first frame the production den-unlock flag became true. */
  trashKillsAtDenUnlock: number | null;
  /** Whether the production den-unlock goal completed. */
  denUnlocked: boolean;
  /**
   * Whether the player entered the den room. The production encounter starts
   * atomically on room entry, so this mirrors the encounter's `started` latch.
   */
  denEntered: boolean;
  /** Whether the real production boss encounter started. */
  encounterStarted: boolean;
  /** Simulated time when the production encounter first started. */
  encounterStartedMs: number | null;
  /**
   * Player level at the moment the boss encounter started. Used to verify that
   * XP pacing delivers the intended fight level (≥10) before the first Floor 2
   * boss. Null when the encounter never started.
   */
  levelAtEncounterStart: number | null;
  /** Whether the real production boss encounter was defeated. */
  encounterDefeated: boolean;
  /** Simulated time when the production encounter was first defeated. */
  encounterDefeatedMs: number | null;
}

/** Hunt-only activity evidence for production Floor 2 progression. */
export interface Floor2HuntMetrics {
  /** Simulated time spent pursuing a still-locked family den. */
  huntTimeMs: number;
  /** Hunt time where the AI emitted its production ENGAGE state. */
  engageTimeMs: number;
  /** ENGAGE share of hunt time, from 0 to 1. */
  engageRatio: number;
  /** Hunt time spent actively fighting or dodging (ENGAGE + RETREAT). */
  activeCombatTimeMs: number;
  /** Active-combat share of hunt time, from 0 to 1. */
  activeCombatRatio: number;
  /** Player-attributed family trash deaths during active hunt frames. */
  familyTrashKills: number;
  /** Neutral trash deaths during active hunt frames. */
  neutralTrashKills: number;
  /** Mean live enemies inside the production director's engagement radius. */
  averageNearbyEnemies: number;
  /** Peak live enemies inside the production director's engagement radius. */
  peakNearbyEnemies: number;
}

/** Complete production Floor 2 progression evidence captured by the headless runner. */
export interface Floor2ProgressionMetrics {
  families: Record<string, Floor2FamilyProgressMetrics>;
  hunt: Floor2HuntMetrics;
  /** Whether the player confirmed the real production Floor 2 staircase exit. */
  exitCompleted: boolean;
}

/** End-of-run equipment usability + reward-resolution invariants. */
export interface EquipmentPlayabilityMetrics {
  /** Total Quartermaster equipment gold observed as spent this run. */
  goldSpentOnEquipment: number;
  /** Generated equipment entries still bagged at run end. */
  baggedGeneratedCount: number;
  /** Generated equipment instances equipped at run end (de-duplicated). */
  equippedGeneratedCount: number;
  /** Unclaimed achievement rewards + non-claimed boss chests at run end. */
  unopenedRewardBoxes: number;
  /** Bagged generated instances that could fill an empty matching slot. */
  unequippedWithEmptySlotCount: number;
}

/**
 * Skill and ability progression observed during a run.
 * Populated from `world.milestoneGrantLog` at run end.
 */
export interface SkillRunMetrics {
  /**
   * Ordered list of every milestone ability grant that fired.
   * Each entry records the skill, ability, milestone level, and game time.
   */
  grants: Array<{
    skillId: string;
    abilityId: string;
    milestoneLevel: number;
    gameTimeMs: number;
  }>;
  /** Number of distinct ability IDs granted (upgrades only counted once). */
  uniqueAbilityCount: number;
  /** Milestone levels reached per skill ID (e.g. `{ swords: [5, 10] }`). */
  milestonesReached: Record<string, number[]>;
}

/**
 * XP/gold collection efficiency for a run: how much loot value the player
 * picked up versus how much value dropped into the world.
 *
 * Caveat: the counters are cumulative for the whole run (they are never reset on
 * a floor transition) and `combinedRatio` sums XP points and gold units, which
 * are different units. It is therefore a **comparison metric across runs of the
 * same seed matrix**, not an economic quantity: compare `combinedRatio` only
 * between arms measured on the same seed/persona matrix, and read `xpRatio` and
 * `goldRatio` when the XP/gold mix itself may have moved.
 */
export interface LootEfficiencyMetrics {
  /** Total XP gem value spawned into the world during the run. */
  xpSpawned: number;
  /** Total XP gem value the player collected. */
  xpCollected: number;
  /** Total gold value spawned into the world during the run. */
  goldSpawned: number;
  /** Total gold value the player collected. */
  goldCollected: number;
  /** `xpCollected / xpSpawned`, or 1 when nothing spawned. */
  xpRatio: number;
  /** `goldCollected / goldSpawned`, or 1 when nothing spawned. */
  goldRatio: number;
  /** Combined `(xp + gold) collected / spawned`, or 1 when nothing spawned. */
  combinedRatio: number;
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
  /**
   * Cumulative simulated time (ms) the player spent in a safe room. The
   * floor-collapse deadline pauses during this time, so it is excluded from the
   * collapse-relevant "active" time used for the official win definition (see
   * `isOfficialWin` / `activeTimeMs` in scoring.ts).
   */
  safeRoomMs: number;
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
  /** Total player XP at run end, including any seeded start-level baseline. */
  totalXp: number;
  /**
   * Player XP at the moment gameplay begins, after scenario/setup/loadout has
   * finished. Callers can subtract this from `totalXp` to derive XP earned
   * during the simulated run.
   */
  runStartXp?: number;
  /** Gold held by the player at run end */
  totalGold: number;
  /** Durable player-attributed Floor 2 trash kills by family id. */
  familyTrashKills?: Record<string, number>;
  /** Named production Floor 1 boss encounter lifecycle evidence. */
  floor1BossProgression?: Floor1BossProgressionMetrics;
  /** Full production Floor 2 den, encounter, and exit progression evidence. */
  floor2Progression?: Floor2ProgressionMetrics;
  /** ID of the starting weapon selected for this run */
  startingWeapon: string;
  /** Optional evaluator cohort that produced this run. */
  playerPersona?: PlayerPersona;
  /** Optional telemetry rollups for AI decision-state accounting. */
  aiTelemetry?: AIDecisionTelemetryMetrics;
  /**
   * Spawner battle-arena rollup captured once at run end. Optional because
   * pre-existing test fixtures for other metrics (e.g. fun-score, ai-scoring)
   * construct `RunStats` shapes manually and don't populate it; runHeadless
   * always sets it.
   */
  spawnerArenas?: SpawnerArenaMetrics;
  /**
   * Opt-in per-run weapon-accuracy rollup (swings, connecting hits, accuracy,
   * multi-hit rate). Present only when the run enabled `recordWeaponTelemetry`;
   * `undefined` otherwise, so default runs and the Floor-1 gate are unaffected.
   */
  weaponTelemetry?: WeaponTelemetrySummary;
  /** End-of-run deterministic equipment/reward playability metrics. */
  equipmentPlayability?: EquipmentPlayabilityMetrics;
  /**
   * Total XP gem value left on the ground when the run ended. These gems are
   * destroyed by the floor transition (scene restart with fresh world). To
   * compute floor-local collection efficiency, use
   * `gainedXp = max(0, totalXp - (runStartXp ?? 0))`, then
   * `gainedXp / (gainedXp + xpOnGroundAtEnd)`. Optional because pre-existing
   * test fixtures construct RunStats manually.
   */
  xpOnGroundAtEnd?: number;
  /**
   * Deterministic loot-collection accounting for the run: total XP/gold value
   * spawned into the world versus the value the player actually picked up.
   * Optional because pre-existing test fixtures construct RunStats manually;
   * `runHeadless` always sets it.
   */
  lootEfficiency?: LootEfficiencyMetrics;
  /** Skill milestone ability grants observed during this run. */
  skills?: SkillRunMetrics;
}
