/**
 * Headless game runner - runs pure ECS simulation at maximum speed.
 *
 * No Phaser, no DOM, no rendering. Perfect for:
 * - AI training and testing
 * - Performance benchmarking
 * - Batch simulation runs
 * - CI regression tests
 */
import { hasComponent, query } from 'bitecs';
import {
  Player,
  Health,
  XpGem,
  createGameWorld,
  spawnPlayer,
  Enemy,
  Spawner,
  type FamilyId,
  type GameWorld,
} from '../../core/index.js';
import { createInputState } from '../../shared/input.js';
import { GAME, ENEMY_PROJECTILE } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { floor2EnemyPack } from '../../shared/enemy-packs.js';
import { FLOOR1_TUTORIAL_QUEST_ID, FLOOR2_LEAVE_FLOOR_QUEST_ID } from '../../shared/quest-types.js';
import { createWeaponTelemetry, summarizeWeaponTelemetry } from '../../core/weapon-telemetry.js';
import { generatedEquipmentRunKeyFromSeed } from '../../shared/generated-equipment-types.js';
import { FLOOR2_STAIRS_DISCOVERED_GOAL_ID, denUnlockGoalId } from '../floor2Scenario.js';
import {
  AIDecisionDebugState,
  AIState,
  type AIInputProvider,
  type AIPathingModeValue,
  type LootEfficiencyMetrics,
  type RunStats,
  type LevelUpEvent,
  type SkillRunMetrics,
} from './types.js';
import { AI_STATE_NAME, getDecisionEventState, type SimEvent } from './event-log.js';
import { runSimulationStep, type SimulationOptions } from './simulation-step.js';
import { getScenarioDefinition } from '../scenarioDefinitions.js';
import { equipStarterOrFallback } from '../scenarios/starterWeaponEquip.js';
import { createFloorMainSceneOptions } from '../../bootstrap/floor-main-scene-options.js';
import {
  autoAllocateStatPoints,
  autoFloor1ProgressionSystem,
  autoFloor2ProgressionSystem,
  autoNpcInteractionSystem,
} from './auto-progression.js';
import {
  runSettlementMaintenancePlanner,
  runEagerMaintenanceTick,
} from './settlement-maintenance-planner.js';
import type { SettlementMaintenanceResult } from './settlement-maintenance-types.js';
import { applyStartPlayerLevel } from '../scenarios/playerLevelProgression.js';
import { computeFloorProgressScore } from './bt-ai-provider.js';
import { QuestProgressStallTracker, formatQuestStallReason } from './quest-stall.js';
import { planningDeadlineMsFromFrameBudget } from './floor1-run-budget.js';
import { configureMerchantWeaponPurchase } from './merchant-weapon-intent.js';
import { configureSpellBrokerPurchase } from './spell-broker-intent.js';
import {
  configureSettlementReturnRouting,
  getSettlementReturnIntent,
  isSettlementReturnRoutingEnabled,
} from './settlement-return-router.js';
import { restockFloor2Quartermaster } from '../quartermaster-stock.js';
import { countEngagingEnemies } from '../floorScenario.js';
import {
  classifyGameOverOutcome,
  collectEquipmentPlayabilityMetrics,
  collectEquipmentPlayabilityViolations,
} from './headless-runner-invariants.js';

const logger = createLogger('game:headless-runner');

/** Tracks the previous-frame safe-room state per world so the restock fires only on the entry edge. */
const quartermasterRestockLatches = new WeakMap<GameWorld, boolean>();

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

function hasFloor2ExitCompleted(world: GameWorld): boolean {
  return (
    world.goalFlags.get(FLOOR2_STAIRS_DISCOVERED_GOAL_ID) === true ||
    world.questLog.get(FLOOR2_LEAVE_FLOOR_QUEST_ID)?.status === 'complete' ||
    readRunState(world) === 'safe_room'
  );
}

function computeXpOnGroundAtEnd(world: GameWorld): number {
  let total = 0;
  for (const eid of query(world.ecs, [XpGem])) {
    if (eid === undefined) continue;
    total += world.stores.xpGem.value[eid] ?? 0;
  }
  return total;
}

function computeLootEfficiency(world: GameWorld): LootEfficiencyMetrics {
  const { xpSpawned, xpCollected, goldSpawned, goldCollected } = world.lootLedger;
  const ratio = (collected: number, spawned: number): number =>
    spawned > 0 ? collected / spawned : 1;
  return {
    xpSpawned,
    xpCollected,
    goldSpawned,
    goldCollected,
    xpRatio: ratio(xpCollected, xpSpawned),
    goldRatio: ratio(goldCollected, goldSpawned),
    combinedRatio: ratio(xpCollected + goldCollected, xpSpawned + goldSpawned),
  };
}

interface EquipmentSpendTelemetry {
  readonly soldOfferKeys: Set<string>;
  goldSpentOnEquipment: number;
}

function createEquipmentSpendTelemetry(): EquipmentSpendTelemetry {
  return {
    soldOfferKeys: new Set<string>(),
    goldSpentOnEquipment: 0,
  };
}

function updateEquipmentSpendTelemetry(world: GameWorld, telemetry: EquipmentSpendTelemetry): void {
  const offers = world.floorExtendedState?.settlement?.quartermasterStock?.offers;
  if (!offers) return;
  for (const offer of offers) {
    if (offer.quantity > 0) continue;
    const key = `${offer.offerId}:${offer.instanceId}`;
    if (telemetry.soldOfferKeys.has(key)) continue;
    telemetry.soldOfferKeys.add(key);
    telemetry.goldSpentOnEquipment += offer.unitPrice;
  }
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
  /** Multiply hostile (Enemy + EnemyProjectile) Damage component amounts by this factor. */
  enemyDamageMultiplier?: number;
  /**
   * Enemy projectile telegraph delay (ms) — the configured default used when
   * a mob has no per-mob `telegraphMs` override (see
   * core/systems/enemyTelegraph.ts's `getEffectiveTelegraphMs`). 0 disables
   * the cue and added delay while preserving pivot-based projectile origins. Production and
   * headless CLI both default to 250.
   */
  enemyTelegraphMs?: number;
  /** Scenario floor id to run. */
  floorId?: string;
  /**
   * Explicit Floor 2 equipment rollout configuration, applied before scenario
   * configuration. Omitted preserves the world defaults (all disabled); each
   * enabled consumer validates its own dependency closure before mutating
   * state. NOTE: on `floorId: 'floor2'`, `initializeFloor2Scenario` (the real
   * shipped path) unconditionally overwrites five flags —
   * `floor2EquipmentRegistry`, `floor2EquipmentCatalog`,
   * `floor2EquipmentRewards`, `floor2EquipmentEconomy`, and
   * `floor2EquipmentAiMaintenance` — as part of Floor 2's shipped content.
   * The remaining two flags (`floor2EquipmentUx`, `floor2EquipmentWorld`)
   * are NOT touched by the scenario initializer and are preserved as-is
   * from any override supplied here. Note `floor2EquipmentUx` and
   * `floor2EquipmentWorld` currently have zero enforcement sites anywhere
   * in `src/` — they are declared-but-unenforced no-op flags, not yet
   * wired to any gate.
   * An override for the five scenario-set flags only has effect when
   * disabling them (e.g. to isolate a scenario on a non-Floor-2 run).
   */
  floor2EquipmentFlags?: Partial<GameWorld['floor2EquipmentFlags']>;
  /**
   * Start the run at this player character level (applies XP and unspent stat
   * points to match). Level 1 (default) is a normal run with no boost.
   * Supports any positive level; clamped to ≥1.
   */
  startPlayerLevel?: number;
  /**
   * Frames of zero floor-progress (no quest objective tick, completion, or gold
   * gain) before the run is declared `'stalled'` and terminated early with a
   * quest-level diagnostic. Keys on quest progress, not on the AI reaching its
   * movement goals, so a knockback/kite deadlock or a "can't find the next NPC"
   * wander fast-fails with a clear reason instead of burning the whole budget.
   * Sized above the slowest legitimate inter-progress gap on winning seeds and
   * above the in-AI relocate cycle (now 200s on the 240×140 map) so it never
   * false-fails a healthy run. Set to 0 to disable. Default 21_600 (~360s at
   * 60 FPS).
   */
  questStallFrames?: number;
  /**
   * Optional deterministic early-stop predicate evaluated once per frame after
   * telemetry updates. When true, the run exits immediately with current stats.
   */
  stopWhen?: (world: GameWorld) => boolean;
  /**
   * Optional inspection hook invoked with the live `GameWorld` after the run
   * completes (or crashes) but before `runHeadless` returns. Used by CI
   * gates that need to statically enumerate entities/components at the end
   * of a deterministic slice — e.g. `check:weight-coverage` walks every
   * Enemy/Player/Prop and asserts `weight.value > 0`. The hook MUST NOT
   * mutate the world; it is called after all simulation stops.
   */
  onFinish?: (world: GameWorld) => void;
  /**
   * Opt-in: collect per-run weapon-accuracy telemetry (swings, connecting hits,
   * accuracy, multi-hit rate) and expose it as `RunStats.weaponTelemetry`. OFF by
   * default — when false the world's `weaponTelemetry` field stays undefined and
   * the simulation pays zero cost, so the Floor-1 gate and determinism are
   * unaffected.
   */
  recordWeaponTelemetry?: boolean;
  /** Use weapon-specific stat and gear personas. Default true; false preserves the legacy control. */
  weaponPersonas?: boolean;
  /**
   * Enable both optional AI purchases (merchant weapon + Floor 1 Spell Broker)
   * as a single shared feature flag. Default false.
   *
   * When true the merchant-weapon purchase decision and the Spell Broker
   * purchase decision are both armed.  When false (the default) neither fires,
   * keeping the AI on the deterministic required-only path.
   *
   * Prefer this flag over the individual `merchantWeaponPurchase` /
   * `spellBrokerPurchase` fields, which are retained only for compatibility
   * with tests and callers that have not yet migrated.  When `optionalPurchases`
   * is supplied it wins over the individual fields.
   */
  optionalPurchases?: boolean;
  /**
   * @deprecated Use `optionalPurchases` instead.  Retained for caller
   * compatibility; `optionalPurchases` takes precedence when provided.
   */
  merchantWeaponPurchase?: boolean;
  /**
   * @deprecated Use `optionalPurchases` instead.  Retained for caller
   * compatibility; `optionalPurchases` takes precedence when provided.
   */
  spellBrokerPurchase?: boolean;
  /**
   * Enable the optional latched settlement-return route goal: periodically
   * evaluates whether returning to the Floor 2 settlement to run the
   * maintenance planner (open boxes, equip affinity-maximizing gear, shop,
   * configure abilities) is worth the travel/risk/opportunity cost, using
   * `settlement-return-router.ts`'s deterministic utility scoring. Default
   * false — when disabled the router's state machine is never armed and the
   * AI's Floor 2 progress goal selection is byte-identical to before this
   * feature.
   */
  settlementReturnRouting?: boolean;
  /**
   * Floor-2-only invariant gate for the end-of-run equipment/reward seam.
   * Keep enabled for normal headless playability runs; tests that
   * intentionally synthesize partial/interrupted routing states may disable it
   * when their subject is the router telemetry itself rather than the final
   * serviced inventory outcome.
   */
  enforcePlayabilityInvariants?: boolean;
}

const DEFAULT_CONFIG: Required<
  Omit<
    HeadlessRunnerConfig,
    | 'simulationOptions'
    | 'recordEvent'
    | 'forceWeaponId'
    | 'onFinish'
    | 'floor2EquipmentFlags'
    | 'stopWhen'
  >
> = {
  seed: 12345,
  maxFrames: 100_000, // ~27 min at 60 FPS
  maxWallTimeMs: 5 * 60 * 1000, // 5 minutes wall time
  progressInterval: 0,
  debug: false,
  eventSampleInterval: 15,
  questStallFrames: 21_600, // ~360s of frozen quest progress on the 240×140 map
  enemyDamageMultiplier: 1,
  enemyTelegraphMs: ENEMY_PROJECTILE.TELEGRAPH_MS,
  floorId: 'floor1',
  startPlayerLevel: 1,
  recordWeaponTelemetry: false,
  weaponPersonas: true,
  optionalPurchases: false,
  merchantWeaponPurchase: false,
  spellBrokerPurchase: false,
  settlementReturnRouting: false,
  enforcePlayabilityInvariants: true,
};

function applyConfiguredHostileDamageMultiplier(
  world: GameWorld,
  configuredMultiplier: number,
): void {
  const clampedMultiplier = normalizeHostileDamageMultiplier(configuredMultiplier);
  // Avoid a deterministic spawn-camp death spiral: apply the high multiplier once
  // the runner has entered objective flow and reached level 2 (post-tutorial
  // unlock point where it can meaningfully execute quest-pathing + dodge).
  const hasStartedObjectiveFlow = world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID);
  const hasCombatMaturity = (world.playerLevel.level ?? 0) >= 2;
  world.hostileDamageMultiplier =
    hasStartedObjectiveFlow && hasCombatMaturity ? clampedMultiplier : 1;
}

function normalizeHostileDamageMultiplier(configuredMultiplier: number): number {
  if (!Number.isFinite(configuredMultiplier)) {
    throw new Error(
      `Invalid enemyDamageMultiplier "${String(configuredMultiplier)}" (must be a finite number)`,
    );
  }
  return Math.max(1, configuredMultiplier);
}

function normalizeEnemyTelegraphMs(configuredTelegraphMs: number | undefined): number | undefined {
  if (configuredTelegraphMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(configuredTelegraphMs) || configuredTelegraphMs < 0) {
    throw new Error(
      `Invalid enemyTelegraphMs "${String(configuredTelegraphMs)}" (must be a finite number >= 0)`,
    );
  }
  // `telegraphDelayMs` (EnemyBehavior component, components.ts) is stored in a
  // Float32Array. A finite JS number outside Float32's representable range
  // rounds to Infinity on assignment -- and isEnemyProjectileTelegraphReady's
  // `elapsed >= delayMs` fire check can then never trip, so the enemy
  // telegraphs forever and never fires (regression: copilot-pull-request-
  // reviewer finding). Math.fround performs the exact same rounding as the
  // Float32Array store, so this rejects anything that would silently become
  // Infinity there.
  if (!Number.isFinite(Math.fround(configuredTelegraphMs))) {
    throw new Error(
      `Invalid enemyTelegraphMs "${String(configuredTelegraphMs)}" (exceeds the largest value representable in the Float32 telegraphDelayMs store)`,
    );
  }
  // Mirror of the Float32-underflow-to-zero guard in
  // core/systems/enemyTelegraph.ts's isFloat32SafeNonNegativeTelegraphMs.
  // Unlike the per-mob store (a Float32Array, where a tiny nonzero override
  // rounds to a stored 0 immediately on write, becoming indistinguishable
  // from an intentional "legacy: no telegraph" override), world.enemyTelegraphMs
  // is a plain JS number preserved at full precision until getEffectiveTelegraphMs
  // resolves it — that resolver's own guard already catches an underflowing
  // world-level value at read time and falls back to the constant (a real,
  // nonzero telegraph), so it can never silently produce immediate-fire
  // behavior. The reason to still reject it here, at config time, is
  // simpler and more honest: the requested duration is too small to survive
  // a round-trip through the Float32-backed telegraphDelayMs store once a
  // telegraph actually starts, so it cannot be preserved as configured and
  // would otherwise be silently replaced by the 250ms default instead of
  // erroring (regression: copilot-pull-request-reviewer finding).
  if (configuredTelegraphMs !== 0 && Math.fround(configuredTelegraphMs) === 0) {
    throw new Error(
      `Invalid enemyTelegraphMs "${String(configuredTelegraphMs)}" (too small to represent in the Float32 telegraphDelayMs store; the requested duration cannot be preserved and would be silently replaced by the default instead of the value you configured)`,
    );
  }
  return configuredTelegraphMs;
}

/**
 * Roll up final spawner battle-arena state from a completed world. Used by
 * `runHeadless` to populate `RunStats.spawnerArenas` so headless win-rate gates
 * (e.g. `tests/headless/spawner-arena-win-rate.test.ts`) can assert every
 * reachable spawner reached its terminal `arenaState === 2`.
 *
 * Non-throwing: if the sim never generated spawners, all counts are zero.
 */
function computeSpawnerArenaMetrics(world: GameWorld): {
  total: number;
  triggered: number;
  resolved: number;
  barrierArmed: number;
  resolvedArmed: number;
  bankedXpTotal: number;
} {
  const spawners = query(world.ecs, [Spawner]);
  let total = 0;
  let triggered = 0;
  let resolved = 0;
  let barrierArmed = 0;
  let resolvedArmed = 0;
  let bankedXpTotal = 0;
  const store = world.stores.spawner;
  for (const eid of spawners) {
    total += 1;
    const state = store.arenaState[eid] ?? 0;
    if (state >= 1) triggered += 1;
    if (state === 2) resolved += 1;
    // Count spawners that raised a *real* barrier at some point in the run via
    // the persistent `spawnerArenaEverArmed` latch. It is set only when a
    // non-empty barrier handle is actually stored, and is
    // NOT cleared on resolve — so a killed arena still counts, while an
    // IDLE→RESOLVED short-circuit (spawner died before it ever armed) does not
    // inflate the count. `resolvedArmed` is the subset that also resolved — the
    // correct numerator for the resolved/armed gate (a bare `resolved` count
    // includes never-armed short-circuits and would dilute the ratio to 1.0).
    const everArmed = world.spawnerArenaEverArmed?.has(eid) ?? false;
    if (everArmed) {
      barrierArmed += 1;
      if (state === 2) resolvedArmed += 1;
    }
    bankedXpTotal += store.bankedXp[eid] ?? 0;
  }
  return { total, triggered, resolved, barrierArmed, resolvedArmed, bankedXpTotal };
}

function collectFamilyTrashKills(world: GameWorld): Record<string, number> {
  return Object.fromEntries(world.floorExtendedState?.familyState?.trashKillsByFamily ?? []);
}

interface Floor1BossTelemetry {
  readonly startedFrame: ReadonlyMap<string, number>;
  readonly startedMs: ReadonlyMap<string, number>;
  readonly startedBossEid: ReadonlyMap<string, number>;
  readonly startedLevel: ReadonlyMap<string, number>;
  readonly startedHealthFraction: ReadonlyMap<string, number>;
  readonly defeatedFrame: ReadonlyMap<string, number>;
  readonly defeatedMs: ReadonlyMap<string, number>;
}

function collectFloor1BossProgression(
  world: GameWorld,
  telemetry: Floor1BossTelemetry,
): NonNullable<RunStats['floor1BossProgression']> | undefined {
  const bossBattles = world.floorScenario?.objective.bossBattles;
  if (world.floorId !== 'floor1' || !bossBattles) {
    return undefined;
  }
  const encounters: NonNullable<RunStats['floor1BossProgression']>['encounters'] = {};
  for (const [bossId, encounter] of bossBattles) {
    encounters[bossId] = {
      bossEid: telemetry.startedBossEid.get(bossId) ?? null,
      encounterStarted: encounter.started,
      encounterStartedFrame: telemetry.startedFrame.get(bossId) ?? null,
      encounterStartedMs: telemetry.startedMs.get(bossId) ?? null,
      playerLevelAtStart: telemetry.startedLevel.get(bossId) ?? null,
      playerHealthFractionAtStart: telemetry.startedHealthFraction.get(bossId) ?? null,
      encounterDefeated: encounter.defeated,
      encounterDefeatedFrame: telemetry.defeatedFrame.get(bossId) ?? null,
      encounterDefeatedMs: telemetry.defeatedMs.get(bossId) ?? null,
    };
  }
  return { encounters };
}

function collectFloor2Progression(
  world: GameWorld,
  trashKillsAtDenUnlock: ReadonlyMap<string, number>,
  encounterStartedMs: ReadonlyMap<string, number>,
  encounterStartedLevel: ReadonlyMap<string, number>,
  encounterDefeatedMs: ReadonlyMap<string, number>,
  hunt: NonNullable<RunStats['floor2Progression']>['hunt'],
): NonNullable<RunStats['floor2Progression']> | undefined {
  const floor2State = world.floorExtendedState?.familyState;
  if (world.floorId !== 'floor2' || !floor2State) {
    return undefined;
  }
  const families: NonNullable<RunStats['floor2Progression']>['families'] = {};
  for (const familyId of floor2State.presentFamilies) {
    const encounter = floor2State.bossEncounters?.get(familyId);
    const encounterStarted = encounter?.started === true;
    families[familyId] = {
      trashKills: floor2State.trashKillsByFamily?.get(familyId) ?? 0,
      trashKillsAtDenUnlock: trashKillsAtDenUnlock.get(familyId) ?? null,
      denUnlocked: world.goalFlags.get(denUnlockGoalId(familyId)) === true,
      denEntered: encounterStarted,
      encounterStarted,
      encounterStartedMs: encounterStartedMs.get(familyId) ?? null,
      levelAtEncounterStart: encounterStartedLevel.get(familyId) ?? null,
      encounterDefeated: encounter?.defeated === true,
      encounterDefeatedMs: encounterDefeatedMs.get(familyId) ?? null,
    };
  }
  return {
    families,
    hunt,
    exitCompleted: hasFloor2ExitCompleted(world),
  };
}

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
  aiProvider.configurePlanningDeadlineMs?.(
    planningDeadlineMsFromFrameBudget(mergedConfig.maxFrames),
  );
  const startTime = Date.now();

  if (mergedConfig.debug) {
    logger.info('Starting headless run', mergedConfig);
  }

  // Create world and spawn player
  // Mirrors MainGameScene: always derive a stable generated-equipment run key
  // from the world seed, so resolve-at-unlock reward bundles (Floor 1
  // lootBox + Floor 2 equipment) work identically in headless AI runs.
  const world = createGameWorld({
    seed: mergedConfig.seed,
    generatedEquipmentRunKey: generatedEquipmentRunKeyFromSeed(mergedConfig.seed),
  });
  if (mergedConfig.floor2EquipmentFlags) {
    Object.assign(world.floor2EquipmentFlags, mergedConfig.floor2EquipmentFlags);
  }
  world.enemyTelegraphMs = normalizeEnemyTelegraphMs(mergedConfig.enemyTelegraphMs);
  // `optionalPurchases` is the canonical single flag.  When supplied it
  // overrides the individual deprecated fields; when absent the individual
  // fields are used for backward compat with existing callers/tests.
  const purchasesEnabled =
    config.optionalPurchases !== undefined
      ? config.optionalPurchases
      : mergedConfig.merchantWeaponPurchase || mergedConfig.spellBrokerPurchase;
  configureMerchantWeaponPurchase(world, purchasesEnabled);
  configureSpellBrokerPurchase(world, purchasesEnabled);
  configureSettlementReturnRouting(world, mergedConfig.settlementReturnRouting);
  if (mergedConfig.recordWeaponTelemetry) {
    world.weaponTelemetry = createWeaponTelemetry();
  }
  const playerEid = spawnPlayer(world, 400, 400);
  const hostileDamageMultiplier = normalizeHostileDamageMultiplier(
    mergedConfig.enemyDamageMultiplier,
  );

  // Apply the intended player level BEFORE scenario configuration so that any
  // settlement or stock generation that reads world.playerLevel during
  // configureWorld (e.g. Floor 2 Quartermaster stock) sees the correct level.
  // applyStartPlayerLevel is raise-only, so scenario-internal level overrides
  // (e.g. applyFloor2DirectStartPlayerState) are no-ops when the requested
  // level is already >= the baseline they would set.
  applyStartPlayerLevel(world, mergedConfig.startPlayerLevel);

  // Initialize selected scenario (map/objective/NPC wiring).
  const scenario = getScenarioDefinition(mergedConfig.floorId);
  scenario.configureWorld(world, playerEid);
  applyConfiguredHostileDamageMultiplier(world, hostileDamageMultiplier);

  // Select starter weapon when the scenario exposes a loadout phase.
  let starterWeaponIndex = 0;
  const forceWeaponId = config.forceWeaponId;
  if (scenario.selectLoadoutOption && world.state === 'loadout') {
    if (forceWeaponId !== undefined && world.floorScenario) {
      const idx = world.floorScenario.starterChoices.indexOf(forceWeaponId);
      if (idx === -1) {
        if (!getWeaponDef(forceWeaponId)) {
          throw new Error(`Unknown forceWeaponId "${forceWeaponId}"`);
        }
        world.floorScenario.starterChoices.push(forceWeaponId);
        starterWeaponIndex = world.floorScenario.starterChoices.length - 1;
      } else {
        starterWeaponIndex = idx;
      }
    }
    scenario.selectLoadoutOption(world, starterWeaponIndex);
  } else if (forceWeaponId !== undefined) {
    const weaponDef = getWeaponDef(forceWeaponId);
    if (!weaponDef) {
      throw new Error(`Unknown forceWeaponId "${forceWeaponId}"`);
    }
    equipStarterOrFallback(world, forceWeaponId, weaponDef);
  }

  const startingWeapon: string =
    forceWeaponId ??
    world.floorScenario?.selectedWeaponId ??
    world.floorScenario?.starterChoices[starterWeaponIndex] ??
    'unknown';

  // Verify we transitioned to 'playing' state
  if (world.state !== 'playing') {
    throw new Error(`Failed to transition from loadout: state is ${world.state}`);
  }
  const runStartXp = world.playerLevel?.xp ?? 0;
  const inputState = createInputState();

  let frameCount = 0;
  // Frames spent in a safe room, where the floor-collapse deadline is paused
  // (floorScenario extends `objective.deadlineMs` by one DELTA each frame
  // `world.playerInSafeRoom` is true). Counting under the exact same condition,
  // read after the sim step that runs safeRoomSystem + floorObjectiveSystem,
  // makes `safeRoomMs` match the game's deadline pause frame-for-frame.
  let safeRoomFrames = 0;
  let lastProgressFrame = 0;
  let outcome: RunStats['outcome'] = 'timeout';
  let stallReason: string | undefined;
  const stallTracker = new QuestProgressStallTracker(mergedConfig.questStallFrames);

  // Metric trackers
  const levelUps: LevelUpEvent[] = [];
  let previousLevel = 0;
  const killsByType: Record<string, number> = {};
  let totalKills = 0;
  let combatEventCursor = world.combatEvents.length;
  let lastProcessedCombatEvent = world.combatEvents[combatEventCursor - 1];
  let minHealthPercent = 1.0;
  let closeCallCount = 0;
  let lowHealthCount = 0;
  let combatTimeMs = 0;
  let engagementCount = 0;
  let inCombat = false;
  let combatStartFrame = 0;
  let damageDealt = 0;
  let damageTaken = 0;
  const damageTakenBySource: Record<string, number> = {};
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
  const floor2TrashKillsAtDenUnlock = new Map<string, number>();
  const floor2EncounterStartedMs = new Map<string, number>();
  const floor2EncounterStartedLevel = new Map<string, number>();
  const floor2EncounterDefeatedMs = new Map<string, number>();
  const floor1BossStartedFrame = new Map<string, number>();
  const floor1BossStartedMs = new Map<string, number>();
  const floor1BossStartedEid = new Map<string, number>();
  const floor1BossStartedLevel = new Map<string, number>();
  const floor1BossStartedHealthFraction = new Map<string, number>();
  const floor1BossDefeatedFrame = new Map<string, number>();
  const floor1BossDefeatedMs = new Map<string, number>();
  const equipmentSpendTelemetry = createEquipmentSpendTelemetry();

  // Latches the Floor 1 boss encounter transitions for the frame that just ran.
  // Called immediately after runSimulationStep/frameCount++ so a lethal frame —
  // which breaks out of the loop before any later telemetry block — still records
  // the frame, time, level, health, and boss eid of a start/defeat that happened
  // on that same frame.
  const captureFloor1BossTransitions = (): void => {
    const bossBattles = world.floorScenario?.objective.bossBattles;
    if (world.floorId !== 'floor1' || !bossBattles) {
      return;
    }
    for (const [bossId, encounter] of bossBattles) {
      if (encounter.started && !floor1BossStartedFrame.has(bossId)) {
        floor1BossStartedFrame.set(bossId, frameCount);
        floor1BossStartedMs.set(bossId, world.elapsedMs);
        floor1BossStartedLevel.set(bossId, world.playerLevel?.level ?? 0);
        const currentHealth = world.stores.health.current[playerEid] ?? 0;
        const maxHealth = world.stores.health.max[playerEid] ?? 0;
        floor1BossStartedHealthFraction.set(bossId, maxHealth > 0 ? currentHealth / maxHealth : 0);
        if (encounter.bossEid !== null) {
          floor1BossStartedEid.set(bossId, encounter.bossEid);
        }
      }
      if (encounter.defeated && !floor1BossDefeatedFrame.has(bossId)) {
        floor1BossDefeatedFrame.set(bossId, frameCount);
        floor1BossDefeatedMs.set(bossId, world.elapsedMs);
      }
    }
  };

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
    getTacticalRunDebug?: () => {
      runPlan: { slackMs: number; urgency: number } | null;
      decisionRunPlan?: { slackMs: number; urgency: number } | null;
    };
    getDecisionMode?: () => string;
    getPathingMode?: () => AIPathingModeValue;
    getFloor2HuntFamilyId?: () => FamilyId | null;
  };
  let lastFrameX = world.stores.position.x[playerEid] ?? 0;
  let lastFrameY = world.stores.position.y[playerEid] ?? 0;
  let pathTravelAccum = 0;
  let lastSampleX = lastFrameX;
  let lastSampleY = lastFrameY;
  let lastLoggedState: string | null = null;
  const decisionStateCounts: Record<string, number> = {};
  const decisionStateMs: Record<string, number> = {};
  let floor2HuntTimeMs = 0;
  let floor2HuntEngageTimeMs = 0;
  let floor2HuntActiveCombatTimeMs = 0;
  let floor2HuntFamilyTrashKills = 0;
  let floor2HuntNeutralTrashKills = 0;
  let floor2HuntNearbyEnemySamples = 0;
  let floor2HuntNearbyEnemyTotal = 0;
  let floor2HuntNearbyEnemyPeak = 0;
  let activeFloor2HuntFamilyId: string | null;
  // Tracks the settlement-return-router status last emitted as a telemetry
  // event, so only genuine transitions are recorded (not one event per
  // frame while a status is held).
  let lastSettlementReturnStatus: string | null = null;

  const recordDecisionState = (state: string): void => {
    decisionStateCounts[state] = (decisionStateCounts[state] ?? 0) + 1;
    decisionStateMs[state] = (decisionStateMs[state] ?? 0) + GAME.DELTA_MS;
  };

  const buildAiTelemetry = (): NonNullable<RunStats['aiTelemetry']> => {
    const suppressedState = AIDecisionDebugState.SUPPRESSED_PROGRESS_NAV;
    return {
      decisionStateCounts: { ...decisionStateCounts },
      decisionStateMs: { ...decisionStateMs },
      suppressedProgressNavCount: decisionStateCounts[suppressedState] ?? 0,
      suppressedProgressNavMs: decisionStateMs[suppressedState] ?? 0,
    };
  };

  const collectSkillMetrics = (): SkillRunMetrics => {
    const grants = world.milestoneGrantLog.map((g) => ({ ...g }));
    const uniqueAbilityCount = new Set(grants.map((g) => g.abilityId)).size;
    const milestonesReached: Record<string, number[]> = {};
    for (const g of grants) {
      (milestonesReached[g.skillId] ??= []).push(g.milestoneLevel);
    }
    return { grants, uniqueAbilityCount, milestonesReached };
  };

  const buildFloor2HuntMetrics = (): NonNullable<RunStats['floor2Progression']>['hunt'] => ({
    huntTimeMs: floor2HuntTimeMs,
    engageTimeMs: floor2HuntEngageTimeMs,
    engageRatio: floor2HuntTimeMs > 0 ? floor2HuntEngageTimeMs / floor2HuntTimeMs : 0,
    activeCombatTimeMs: floor2HuntActiveCombatTimeMs,
    activeCombatRatio: floor2HuntTimeMs > 0 ? floor2HuntActiveCombatTimeMs / floor2HuntTimeMs : 0,
    familyTrashKills: floor2HuntFamilyTrashKills,
    neutralTrashKills: floor2HuntNeutralTrashKills,
    averageNearbyEnemies:
      floor2HuntNearbyEnemySamples > 0
        ? floor2HuntNearbyEnemyTotal / floor2HuntNearbyEnemySamples
        : 0,
    peakNearbyEnemies: floor2HuntNearbyEnemyPeak,
  });

  const buildEvent = (
    type: SimEvent['type'],
    enemyEids: ArrayLike<number> & Iterable<number>,
    note?: string,
  ): SimEvent => {
    const decision = aiProvider.getDecision();
    const baseState = AI_STATE_NAME[decision.state] ?? String(decision.state);
    const decisionDebug = decision.debug ? { ...decision.debug } : null;
    const emittedState = getDecisionEventState(decision);
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
    const targetHealth =
      decision.targetEid !== null && hasComponent(world.ecs, decision.targetEid, Health)
        ? {
            current: Math.round(world.stores.health.current[decision.targetEid] ?? 0),
            max: Math.round(world.stores.health.max[decision.targetEid] ?? 0),
          }
        : null;
    const targetArchetype =
      decision.targetEid === null
        ? null
        : (world.floorExtendedState?.ambientEnemyArchetypes?.get(decision.targetEid) ?? null);
    const nav = navProvider.getNavigationDebug?.();
    const netDisp = Math.hypot(px - lastSampleX, py - lastSampleY);
    // A/B telemetry (axis 2): emit run-plan slack/urgency and the decision mode
    // when the provider exposes them. Optional-chained + present-only, so a
    // provider WITHOUT these getters (e.g. a scripted/bare provider) emits
    // nothing new. A BehaviorTreeAI DOES expose them, so even in LEGACY mode it
    // emits `decisionMode: 'legacy'` and — on travelling samples — `slackMs`/
    // `urgency` (from the post-tick `runPlan`). That is an observability
    // superset, NOT part of the deterministic sim: game behavior/determinism
    // stays byte-identical to main; only the emitted telemetry field set is
    // broader. Falls back to the post-tick `runPlan` when no decision-time
    // plan is available.
    const tacticalDebug = navProvider.getTacticalRunDebug?.();
    const runPlan = tacticalDebug?.decisionRunPlan ?? tacticalDebug?.runPlan ?? null;
    const decisionMode = navProvider.getDecisionMode?.();
    return {
      type,
      frame: frameCount,
      gameMs: world.elapsedMs,
      px: Math.round(px),
      py: Math.round(py),
      state: emittedState,
      ...(decisionDebug ? { baseState, decisionDebug } : {}),
      reason: decision.reason,
      targetEid: decision.targetEid,
      targetDist: targetDist === null ? null : Math.round(targetDist),
      targetHealth,
      targetArchetype,
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
      remainingMs:
        world.floorScenario?.objective.deadlineMs != null
          ? Math.round(world.floorScenario.objective.deadlineMs - world.elapsedMs)
          : null,
      inSafe: world.playerInSafeRoom === true,
      ...(runPlan ? { slackMs: Math.round(runPlan.slackMs), urgency: runPlan.urgency } : {}),
      ...(decisionMode ? { decisionMode } : {}),
      ...(note ? { note } : {}),
    };
  };

  try {
    // Build the canonical pre/post system arrays from the floor's scene options —
    // the single source of truth shared with the visual pipeline. Any caller-
    // supplied simulationOptions.preSystems/postSystems are appended after the
    // canonical ones so tests can inject extra instrumentation without clobbering
    // the canonical ordering.
    const sceneOptions = createFloorMainSceneOptions(mergedConfig.floorId);
    const canonicalPreSystems = sceneOptions.preSystems ?? [];
    const canonicalPostSystems = sceneOptions.postSystems ?? [];
    const mergedPreSystems = [
      ...canonicalPreSystems,
      ...(config.simulationOptions?.preSystems ?? []),
    ];
    const mergedPostSystems = [
      ...canonicalPostSystems,
      ...(config.simulationOptions?.postSystems ?? []),
    ];

    // Main simulation loop
    while (frameCount < mergedConfig.maxFrames) {
      // Check wall-clock timeout
      const elapsed = Date.now() - startTime;
      if (elapsed > mergedConfig.maxWallTimeMs) {
        outcome = 'timeout';
        break;
      }

      // Track state before frame
      const previousPlayerHealth = world.stores.health.current[playerEid] ?? 0;

      // AI decides input for this frame.
      aiProvider.poll(inputState, world);
      const decision = aiProvider.getDecision();
      recordDecisionState(getDecisionEventState(decision));
      const committedHuntFamilyId = navProvider.getFloor2HuntFamilyId?.() ?? null;
      activeFloor2HuntFamilyId =
        world.floorId === 'floor2' &&
        committedHuntFamilyId !== null &&
        world.goalFlags.get(denUnlockGoalId(committedHuntFamilyId)) !== true &&
        world.questLog.get(`floor2-den-${committedHuntFamilyId}-unlock`)?.status === 'active'
          ? committedHuntFamilyId
          : null;
      if (activeFloor2HuntFamilyId !== null) {
        floor2HuntTimeMs += GAME.DELTA_MS;
        if (decision.state === AIState.ENGAGE) {
          floor2HuntEngageTimeMs += GAME.DELTA_MS;
        }
        if (decision.state === AIState.ENGAGE || decision.state === AIState.RETREAT) {
          floor2HuntActiveCombatTimeMs += GAME.DELTA_MS;
        }
      }

      // Auto-interact with nearby NPCs (simulates pressing E)
      lastNpcInteractionFrame = autoNpcInteractionSystem(
        world,
        aiProvider,
        lastNpcInteractionFrame,
        frameCount,
        NPC_INTERACTION_COOLDOWN,
      );
      applyConfiguredHostileDamageMultiplier(world, hostileDamageMultiplier);

      // Mirror MainGameScene.update(): reset `level_up` to `playing` before each
      // simulation step so postSystems (levelSystem → floorObjectiveSystem) can
      // see the correct state. The visual game does this in the scene update loop
      // between frames; the headless runner has no UI, so we reset it here instead
      // of blocking on a stat-allocation screen.
      // `readRunState` is used to escape TypeScript's narrowing on world.state
      // (which was narrowed to 'playing' at the loop entry guard above).
      if (readRunState(world) === 'level_up') {
        world.state = 'playing';
      }

      // Run one simulation step using the canonical preSystems/postSystems derived
      // from createFloorMainSceneOptions() — the same source the visual pipeline
      // uses. This ensures both pipelines share one ordering definition (issue #663).
      runSimulationStep(world, inputState, GAME.DELTA_MS, {
        preSystems: mergedPreSystems,
        postSystems: mergedPostSystems,
        meleeBroadPhase: config.simulationOptions?.meleeBroadPhase,
        beamBroadPhase: config.simulationOptions?.beamBroadPhase,
      });
      // Commit this frame's counters the moment runSimulationStep returns: at that
      // point world.elapsedMs has advanced and safeRoomSystem/floorObjectiveSystem
      // have already run inside the step, so world.playerInSafeRoom reflects THIS
      // frame's deadline pause. Incrementing here (rather than after the auto*
      // helpers below) keeps frameCount/safeRoomFrames consistent with
      // world.elapsedMs even if a later helper throws and we emit crash stats.
      frameCount++;
      // Latch Floor 1 boss lifecycle transitions before any early exit (death
      // guards) or auto-action helper can run, so a start/defeat on a lethal
      // frame is still recorded with its frame/time/eid evidence.
      captureFloor1BossTransitions();
      if (world.playerInSafeRoom === true) {
        safeRoomFrames++;
      }
      // Floor objective handling (including Floor 2 objective ticks) runs inside
      // runSimulationStep, so no second explicit objective call is needed here.
      autoFloor1ProgressionSystem(world, playerEid, aiProvider, config.weaponPersonas);
      autoFloor2ProgressionSystem(world, playerEid);
      // On each new safe-room entry, advance the Quartermaster restock epoch so
      // sold items are retired and fresh offers are generated. The call is
      // unconditional: `restockFloor2Quartermaster` guards against a disabled
      // economy, missing settlement, and backwards/skipped epoch requests and
      // returns a typed error result rather than throwing, so this is safe on
      // Floor 1 runs and on every frame after the initial entry-edge.
      const isNowInSafeRoom = world.playerInSafeRoom === true;
      const wasInSafeRoom = quartermasterRestockLatches.get(world) ?? false;
      if (isNowInSafeRoom && !wasInSafeRoom) {
        const qmStock = world.floorExtendedState?.settlement?.quartermasterStock;
        if (qmStock) {
          restockFloor2Quartermaster(world, qmStock.restockEpoch + 1);
        }
      }
      quartermasterRestockLatches.set(world, isNowInSafeRoom);
      runEagerMaintenanceTick(world, playerEid, {
        // When settlement-return routing is active, the router uses unclaimed
        // achievements as its navigation signal (utility ∝ unclaimedAchievements).
        // Claiming them eagerly here would drop utility to zero on the next frame,
        // causing the router to defer its trip before the player reaches the
        // settlement. The settlement planner handles claiming on arrival instead.
        skipAchievementClaims: isSettlementReturnRoutingEnabled(world),
      });
      // Capture result type so `SettlementMaintenanceResult` has a production
      // src consumer; result is also accessible via getLastSettlementMaintenanceResult(world).
      const _settlementResult: SettlementMaintenanceResult = runSettlementMaintenancePlanner(world);
      void _settlementResult;
      autoAllocateStatPoints(world, playerEid, config.weaponPersonas);
      updateEquipmentSpendTelemetry(world, equipmentSpendTelemetry);

      // Check win/loss conditions — read HP before the guard so both early-exit
      // paths can record the final frame's HP delta (otherwise the lethal frame
      // is skipped and damageTaken under-counts on one-shot deaths).
      const playerHealth = world.stores.health.current[playerEid] ?? 0;
      if (
        !hasComponent(world.ecs, playerEid, Player) ||
        !hasComponent(world.ecs, playerEid, Health)
      ) {
        outcome = 'death';
        if (previousPlayerHealth > playerHealth) {
          damageTaken += previousPlayerHealth - playerHealth;
        }
        break;
      }

      if (playerHealth <= 0) {
        outcome = 'death';
        if (previousPlayerHealth > playerHealth) {
          damageTaken += previousPlayerHealth - playerHealth;
        }
        break;
      }

      // Per-frame enemy snapshot (reused for combat, damage, and telemetry).
      const enemyEids = query(world.ecs, [Enemy]);
      const currentEnemyCount = enemyEids.length;
      if (mergedConfig.settlementReturnRouting) {
        const settlementReturnIntent = getSettlementReturnIntent(world);
        if (settlementReturnIntent.status !== lastSettlementReturnStatus) {
          lastSettlementReturnStatus = settlementReturnIntent.status;
          const latestDecision =
            settlementReturnIntent.decisions[settlementReturnIntent.decisions.length - 1];
          recordEvent?.(
            buildEvent(
              'control',
              enemyEids,
              `settlement-return: ${settlementReturnIntent.status}` +
                (latestDecision ? ` — ${latestDecision.detail}` : ''),
            ),
          );
        }
      }
      if (activeFloor2HuntFamilyId !== null) {
        const playerX = world.stores.position.x[playerEid] ?? 0;
        const playerY = world.stores.position.y[playerEid] ?? 0;
        const engageRadiusSq = floor2EnemyPack.engageRadiusFt ** 2;
        const nearbyEnemies = countEngagingEnemies(world, playerX, playerY, engageRadiusSq);
        floor2HuntNearbyEnemySamples += 1;
        floor2HuntNearbyEnemyTotal += nearbyEnemies;
        floor2HuntNearbyEnemyPeak = Math.max(floor2HuntNearbyEnemyPeak, nearbyEnemies);
      }

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

      // Track real enemy deaths rather than enemy-count deltas. The ambient
      // director legitimately prunes and recycles distant mobs; treating those
      // removals as kills inflates RunStats and obscures Floor 2 attribution.
      const combatEvents = world.combatEvents;
      if (
        combatEventCursor > combatEvents.length ||
        (combatEventCursor > 0 && combatEvents[combatEventCursor - 1] !== lastProcessedCombatEvent)
      ) {
        combatEventCursor = 0;
      }
      for (let eventIndex = combatEventCursor; eventIndex < combatEvents.length; eventIndex += 1) {
        const event = combatEvents[eventIndex]!;
        if (event.type === 'hit' && event.targetType === 'player' && event.amount > 0) {
          // Prefer the pre-snapshotted stable archetype key over the EID lookup:
          // sourceEid is best-effort (may reference a recycled entity). For
          // projectile/AoE hits, sourceArchetypeKey is captured at spawn time;
          // for direct melee hits it is resolved live at hit time.
          const source =
            event.sourceArchetypeKey ??
            (event.sourceEid === undefined
              ? 'unknown'
              : (world.enemyAppearanceKeys.get(event.sourceEid) ??
                world.floorScenario?.enemyArchetypes.get(event.sourceEid) ??
                'unknown'));
          damageTakenBySource[source] = (damageTakenBySource[source] ?? 0) + event.amount;
        }
        if (event.type !== 'death' || event.targetType !== 'enemy') {
          continue;
        }
        totalKills += 1;
        if (world.floor === 2) {
          const classification =
            event.isBoss === 1
              ? 'floor2-boss'
              : (event.familyIndex ?? -1) >= 0
                ? event.sourceEid !== undefined && hasComponent(world.ecs, event.sourceEid, Player)
                  ? 'floor2-family-trash-player'
                  : 'floor2-family-trash-other'
                : 'floor2-neutral-trash';
          killsByType[classification] = (killsByType[classification] ?? 0) + 1;
          if (activeFloor2HuntFamilyId !== null) {
            if (classification === 'floor2-family-trash-player') {
              floor2HuntFamilyTrashKills += 1;
            } else if (classification === 'floor2-neutral-trash') {
              floor2HuntNeutralTrashKills += 1;
            }
          }
        }
        recordEvent?.(buildEvent('kill', enemyEids, `kill ${totalKills}`));
      }
      combatEventCursor = combatEvents.length;
      lastProcessedCombatEvent = combatEvents[combatEventCursor - 1];

      // 4. Quest tracking (basic - would need event system for full tracking)
      if (world.floorScenario) {
        const objective = world.floorScenario.objective;
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
      const floor2State = world.floorExtendedState?.familyState;
      if (world.floorId === 'floor2' && floor2State) {
        for (const familyId of floor2State.presentFamilies) {
          if (
            !floor2TrashKillsAtDenUnlock.has(familyId) &&
            world.goalFlags.get(denUnlockGoalId(familyId)) === true
          ) {
            floor2TrashKillsAtDenUnlock.set(
              familyId,
              floor2State.trashKillsByFamily?.get(familyId) ?? 0,
            );
          }
          const encounter = floor2State.bossEncounters?.get(familyId);
          if (encounter?.started === true && !floor2EncounterStartedMs.has(familyId)) {
            floor2EncounterStartedMs.set(familyId, world.elapsedMs);
            floor2EncounterStartedLevel.set(familyId, world.playerLevel?.level ?? 0);
          }
          if (encounter?.defeated === true && !floor2EncounterDefeatedMs.has(familyId)) {
            floor2EncounterDefeatedMs.set(familyId, world.elapsedMs);
          }
        }
      }
      if (mergedConfig.stopWhen?.(world)) {
        break;
      }

      // Telemetry: state-change annotations + periodic samples.
      if (recordEvent) {
        const decisionState = getDecisionEventState(aiProvider.getDecision());
        if (decisionState !== lastLoggedState) {
          recordEvent(buildEvent('state', enemyEids, `state -> ${decisionState}`));
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
      if (world.floorScenario?.runSummary?.outcome === 'cleared_floor') {
        outcome = 'victory';
        break;
      }
      if (world.floorId === 'floor2' && hasFloor2ExitCompleted(world)) {
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
        outcome = classifyGameOverOutcome(world);
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

    // Flush the final frame's combat events so the lethal hit is always attributed.
    // When the run ends via death, `break` exits before the per-frame event-processing
    // loop (lines 836–846), leaving the killing blow unattributed in damageTakenBySource.
    // Processing remaining events here makes the attribution complete for all outcomes
    // without risk of double-counting (on a normal exit combatEventCursor already points
    // past the last processed event, so this loop is a no-op).
    for (
      let eventIndex = combatEventCursor;
      eventIndex < world.combatEvents.length;
      eventIndex += 1
    ) {
      const event = world.combatEvents[eventIndex]!;
      if (event.type === 'hit' && event.targetType === 'player' && event.amount > 0) {
        const source =
          event.sourceArchetypeKey ??
          (event.sourceEid === undefined
            ? 'unknown'
            : (world.enemyAppearanceKeys.get(event.sourceEid) ??
              world.floorScenario?.enemyArchetypes.get(event.sourceEid) ??
              'unknown'));
        damageTakenBySource[source] = (damageTakenBySource[source] ?? 0) + event.amount;
      }
    }

    // If still in combat at end, add remaining time
    if (inCombat) {
      const combatDurationFrames = frameCount - combatStartFrame;
      combatTimeMs += combatDurationFrames * GAME.DELTA_MS;
    }

    const equipmentPlayability = collectEquipmentPlayabilityMetrics(
      world,
      playerEid,
      equipmentSpendTelemetry.goldSpentOnEquipment,
    );
    const playabilityViolations =
      world.floorId === 'floor2' &&
      mergedConfig.settlementReturnRouting &&
      mergedConfig.enforcePlayabilityInvariants
        ? collectEquipmentPlayabilityViolations(equipmentPlayability)
        : [];
    if (playabilityViolations.length > 0) {
      throw new Error(
        `Headless playability invariant failed: ${playabilityViolations.join(' | ')}`,
      );
    }
  } catch (error) {
    logger.error('Headless run crashed', { error });

    const wallTimeMs = Date.now() - startTime;
    const finalScore = world.stores.broadcastScore?.current[playerEid] ?? 0;
    const playerHealth = world.stores.health.current[playerEid] ?? 0;
    const currentHealthPercent = playerHealth / playerMaxHealth;

    const crashStats: RunStats = {
      totalFrames: frameCount,
      wallTimeMs,
      gameTimeMs: world.elapsedMs,
      safeRoomMs: safeRoomFrames * GAME.DELTA_MS,
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
        damageTakenBySource,
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
      runStartXp,
      totalGold: world.playerGold,
      familyTrashKills: collectFamilyTrashKills(world),
      floor1BossProgression: collectFloor1BossProgression(world, {
        startedFrame: floor1BossStartedFrame,
        startedMs: floor1BossStartedMs,
        startedBossEid: floor1BossStartedEid,
        startedLevel: floor1BossStartedLevel,
        startedHealthFraction: floor1BossStartedHealthFraction,
        defeatedFrame: floor1BossDefeatedFrame,
        defeatedMs: floor1BossDefeatedMs,
      }),
      floor2Progression: collectFloor2Progression(
        world,
        floor2TrashKillsAtDenUnlock,
        floor2EncounterStartedMs,
        floor2EncounterStartedLevel,
        floor2EncounterDefeatedMs,
        buildFloor2HuntMetrics(),
      ),
      startingWeapon,
      aiTelemetry: buildAiTelemetry(),
      spawnerArenas: computeSpawnerArenaMetrics(world),
      equipmentPlayability: collectEquipmentPlayabilityMetrics(
        world,
        playerEid,
        equipmentSpendTelemetry.goldSpentOnEquipment,
      ),
      skills: collectSkillMetrics(),
      ...(world.weaponTelemetry
        ? { weaponTelemetry: summarizeWeaponTelemetry(world.weaponTelemetry) }
        : {}),
      xpOnGroundAtEnd: computeXpOnGroundAtEnd(world),
      lootEfficiency: computeLootEfficiency(world),
    };
    if (mergedConfig.onFinish) {
      try {
        mergedConfig.onFinish(world);
      } catch (hookErr) {
        logger.error('Headless runner onFinish hook threw', { error: hookErr });
      }
    }
    return crashStats;
  }

  const wallTimeMs = Date.now() - startTime;
  const fps = (frameCount / wallTimeMs) * 1000;
  const finalScore = world.stores.broadcastScore?.current[playerEid] ?? 0;
  const playerHealth = world.stores.health.current[playerEid] ?? 0;
  const finalHealthPercent = playerHealth / playerMaxHealth;

  // Attribute kills by archetype from the Floor 1 objective tally (accurate).
  if (world.floorScenario) {
    killsByType.rat = world.floorScenario.objective.ratsKilled;
    killsByType.slime = world.floorScenario.objective.slimesKilled;
  }

  // Sum XP gem values remaining on the ground at run end. These gems are
  // destroyed by the scene restart on floor transition (entity world is fresh).
  // Combined with `totalXp` and `runStartXp` this lets callers compute
  // floor-local collection efficiency.
  const xpOnGroundAtEnd = computeXpOnGroundAtEnd(world);

  const stats: RunStats = {
    totalFrames: frameCount,
    wallTimeMs,
    gameTimeMs: world.elapsedMs,
    safeRoomMs: safeRoomFrames * GAME.DELTA_MS,
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
      damageTakenBySource,
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
    runStartXp,
    totalGold: world.playerGold,
    familyTrashKills: collectFamilyTrashKills(world),
    floor1BossProgression: collectFloor1BossProgression(world, {
      startedFrame: floor1BossStartedFrame,
      startedMs: floor1BossStartedMs,
      startedBossEid: floor1BossStartedEid,
      startedLevel: floor1BossStartedLevel,
      startedHealthFraction: floor1BossStartedHealthFraction,
      defeatedFrame: floor1BossDefeatedFrame,
      defeatedMs: floor1BossDefeatedMs,
    }),
    floor2Progression: collectFloor2Progression(
      world,
      floor2TrashKillsAtDenUnlock,
      floor2EncounterStartedMs,
      floor2EncounterStartedLevel,
      floor2EncounterDefeatedMs,
      buildFloor2HuntMetrics(),
    ),
    startingWeapon,
    aiTelemetry: buildAiTelemetry(),
    spawnerArenas: computeSpawnerArenaMetrics(world),
    equipmentPlayability: collectEquipmentPlayabilityMetrics(
      world,
      playerEid,
      equipmentSpendTelemetry.goldSpentOnEquipment,
    ),
    skills: collectSkillMetrics(),
    ...(world.weaponTelemetry
      ? { weaponTelemetry: summarizeWeaponTelemetry(world.weaponTelemetry) }
      : {}),
    xpOnGroundAtEnd,
    lootEfficiency: computeLootEfficiency(world),
  };

  if (mergedConfig.debug || mergedConfig.progressInterval > 0) {
    logger.info('Headless run complete', {
      ...stats,
      fps: fps.toFixed(0),
      combatTimePercent: ((combatTimeMs / world.elapsedMs) * 100).toFixed(1),
    });
  }

  if (mergedConfig.onFinish) {
    try {
      mergedConfig.onFinish(world);
    } catch (hookErr) {
      logger.error('Headless runner onFinish hook threw', { error: hookErr });
    }
  }

  return stats;
}
