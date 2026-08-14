/**
 * Multi-floor progression runner — plays a seed through consecutive floors in
 * one headless run, carrying the player over between them.
 *
 * ## Why this exists
 *
 * `runHeadless` simulates exactly one floor. The visual runner has always
 * chained floors (`src/bootstrap/floor-main-scene-options.ts` captures a
 * `PlayerCarryoverSnapshot` on floor-clear and boots the next floor with it),
 * but nothing headless did — so no sweep could ever answer "can a player
 * actually get from Floor 1 to the end?". Every sweep measured single floors
 * from a cold start, which over-states Floor 2's difficulty (a real Floor-2
 * player arrives leveled and equipped) and never exercises the transition at
 * all.
 *
 * ## Shape
 *
 * This composes `runHeadless` per floor rather than restructuring its frame
 * loop: each leg is an ordinary headless run, and the carryover snapshot from a
 * winning leg is fed into the next leg's scenario configuration — the exact
 * seam the visual runner uses. A leg that does not end in `victory` terminates
 * the progression, because there is no carryover to descend with.
 *
 * The floor order follows each scenario's explicit `nextFloorId`, NOT
 * `getNextFloorId`'s registry-insertion-order derivation, so progression
 * matches what the shipped game actually does when the player takes the stairs.
 */
import type { AIInputProvider, RunStats } from './types.js';
import { runHeadless, type HeadlessRunnerConfig } from './headless-runner.js';
import type { PlayerCarryoverSnapshot } from '../playerCarryover.js';
import { getScenarioDefinition } from '../scenarioDefinitions.js';
import { isFloorImplemented } from '../../shared/floor-registry.js';
import { getActiveTimeBudgetMs, getDefaultMaxFrames } from './floor-run-budget.js';
import { activeTimeMs } from './scoring.js';

/** One floor's leg of a progression run. */
export interface ProgressionLeg {
  floorId: string;
  stats: RunStats;
}

export interface ProgressionRunStats {
  /** Every floor attempted, in play order. Always at least one entry. */
  legs: ProgressionLeg[];
  /** Floor ids that were cleared with a victory, in play order. */
  clearedFloorIds: string[];
  /** The floor the run ended on (the last attempted leg). */
  finalFloorId: string;
  /**
   * True when every floor in the chain ended in victory — i.e. the run reached
   * the end of the progression rather than stopping at a death/timeout.
   */
  reachedFinalVictory: boolean;
  /** Summed simulated game time across all legs (ms). */
  totalGameTimeMs: number;
  /** Summed safe-room (budget-credited) time across all legs (ms). */
  totalSafeRoomMs: number;
  /** Summed ACTIVE time across all legs: game time minus safe-room time (ms). */
  totalActiveTimeMs: number;
  /** Summed simulated frames across all legs. */
  totalFrames: number;
  /** Summed wall-clock time across all legs (ms). */
  totalWallTimeMs: number;
  /**
   * Summed per-floor win budget across the floors actually attempted, or `null`
   * when any attempted floor declares no budget (an unbudgeted floor makes the
   * chained budget undefined rather than silently shorter).
   */
  budgetMs: number | null;
  /**
   * The progression win: reached the final floor's victory AND total active
   * time is under the summed budget. When `budgetMs` is null this is identical
   * to `reachedFinalVictory`, matching how single-floor classification treats an
   * unbudgeted floor.
   */
  officialWin: boolean;
}

/**
 * Resolve the chain of floors starting at `startFloorId`, following each
 * scenario's `nextFloorId` and stopping at the first floor that is not
 * implemented E2E (an unfinishable floor cannot be part of a progression whose
 * win condition is reaching the end).
 *
 * Guards against a cyclic `nextFloorId` graph, which would otherwise hang the
 * runner forever rather than failing.
 */
export function resolveFloorChain(startFloorId: string): string[] {
  if (!isFloorImplemented(startFloorId)) {
    throw new Error(
      `Cannot start a progression on "${startFloorId}": it is not an implemented floor.`,
    );
  }
  const chain: string[] = [];
  const seen = new Set<string>();
  let floorId: string | undefined = startFloorId;
  while (floorId !== undefined && isFloorImplemented(floorId)) {
    if (seen.has(floorId)) {
      throw new Error(
        `Cyclic floor progression detected at "${floorId}" (chain so far: ${chain.join(' → ')}).`,
      );
    }
    seen.add(floorId);
    chain.push(floorId);
    floorId = getScenarioDefinition(floorId).nextFloorId;
  }
  return chain;
}

/** Sum the per-floor budgets, or null when any floor declares none. */
function sumBudgets(floorIds: readonly string[]): number | null {
  let total = 0;
  for (const floorId of floorIds) {
    const budget = getActiveTimeBudgetMs(floorId);
    if (budget === null) return null;
    total += budget;
  }
  return total;
}

export interface ProgressionRunConfig extends Omit<
  HeadlessRunnerConfig,
  'floorId' | 'playerCarryover' | 'onPlayerCarryoverCaptured'
> {
  /** Floor to start the progression on. Defaults to `floor1`. */
  startFloorId?: string;
  /**
   * Per-leg frame cap. Omitted resolves each floor's own budget-derived cap
   * from its manifest, so a long floor is not truncated by a short floor's cap.
   */
  maxFramesPerFloor?: number;
}

/**
 * Play a seed through the whole implemented floor chain, carrying the player
 * over between floors, and report per-leg plus aggregate stats.
 */
export async function runProgression(
  createAi: (floorId: string, legIndex: number) => AIInputProvider,
  config: ProgressionRunConfig,
): Promise<ProgressionRunStats> {
  const { startFloorId = 'floor1', maxFramesPerFloor, ...runnerConfig } = config;
  const chain = resolveFloorChain(startFloorId);

  const legs: ProgressionLeg[] = [];
  const clearedFloorIds: string[] = [];
  let carryover: PlayerCarryoverSnapshot | undefined;

  for (const [legIndex, floorId] of chain.entries()) {
    const maxFrames =
      maxFramesPerFloor ?? runnerConfig.maxFrames ?? getDefaultMaxFrames(floorId) ?? undefined;
    let capturedCarryover: PlayerCarryoverSnapshot | undefined;
    const stats = await runHeadless(createAi(floorId, legIndex), {
      ...runnerConfig,
      ...(maxFrames === undefined ? {} : { maxFrames }),
      floorId,
      ...(carryover ? { playerCarryover: carryover } : {}),
      onPlayerCarryoverCaptured: (snapshot) => {
        capturedCarryover = snapshot;
      },
    });
    legs.push({ floorId, stats });

    if (stats.outcome !== 'victory') break;
    clearedFloorIds.push(floorId);
    // A victory with no captured snapshot would silently restart the next floor
    // from a cold level-1 player and quietly invalidate the whole progression
    // measurement, so stop instead of reporting a meaningless downstream leg.
    if (capturedCarryover === undefined) break;
    carryover = capturedCarryover;
  }

  const attemptedFloorIds = legs.map((leg) => leg.floorId);
  const reachedFinalVictory = clearedFloorIds.length === chain.length;
  const totalGameTimeMs = legs.reduce((sum, leg) => sum + leg.stats.gameTimeMs, 0);
  const totalSafeRoomMs = legs.reduce((sum, leg) => sum + leg.stats.safeRoomMs, 0);
  // Sum per-leg ACTIVE time via the shared scoring helper rather than
  // subtracting the two totals, so this stays consistent with `isOfficialWin`'s
  // definition if `activeTimeMs` ever changes.
  const totalActiveTimeMs = legs.reduce((sum, leg) => sum + activeTimeMs(leg.stats), 0);
  const budgetMs = sumBudgets(attemptedFloorIds.length > 0 ? chain : [startFloorId]);

  return {
    legs,
    clearedFloorIds,
    finalFloorId: legs[legs.length - 1]?.floorId ?? startFloorId,
    reachedFinalVictory,
    totalGameTimeMs,
    totalSafeRoomMs,
    totalActiveTimeMs,
    totalFrames: legs.reduce((sum, leg) => sum + leg.stats.totalFrames, 0),
    totalWallTimeMs: legs.reduce((sum, leg) => sum + leg.stats.wallTimeMs, 0),
    budgetMs,
    officialWin: reachedFinalVictory && (budgetMs === null || totalActiveTimeMs < budgetMs),
  };
}
