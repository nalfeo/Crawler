import type { ProgressionRunStats } from '../../../src/game/ai/progression-runner.js';
import type { RunStats } from '../../../src/game/ai/types.js';

export interface ChainedRunStats extends RunStats {
  chainedBudgetMs: number | null;
  chainedOfficialWin: boolean;
  chainedFloorIds: string[];
  chainedClearedFloorIds: string[];
  /** Unmodified floor-local evidence, including carryover and coverage. */
  chainedLegs: ProgressionRunStats['legs'];
}

const valid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Aggregate attempted legs only. A death/timeout is a measured terminal leg;
 * an error, missing coverage, or a malformed intermediate leg is not.
 * Win/budget decisions remain exclusively owned by the progression runner.
 */
export function aggregateProgression(progression: ProgressionRunStats): ChainedRunStats {
  const legs = progression.legs;
  const first = legs[0]?.stats;
  const last = legs.at(-1)?.stats;
  if (!first || !last) throw new Error('Progression run produced no legs.');
  const runs = legs.map((leg) => leg.stats);
  const sum = (read: (run: RunStats) => number): number =>
    runs.reduce((total, run) => total + read(run), 0);
  const base: ChainedRunStats = {
    ...last,
    outcome: progression.reachedFinalVictory ? 'victory' : last.outcome,
    gameTimeMs: progression.totalGameTimeMs,
    safeRoomMs: progression.totalSafeRoomMs,
    totalFrames: progression.totalFrames,
    wallTimeMs: progression.totalWallTimeMs,
    chainedBudgetMs: progression.budgetMs,
    chainedOfficialWin: progression.officialWin,
    chainedFloorIds: legs.map((leg) => leg.floorId),
    chainedClearedFloorIds: [...progression.clearedFloorIds],
    chainedLegs: legs,
  };

  const expectedFloors = [...progression.winnableFloorIds, ...progression.exhibitionFloorIds];
  const chainValid =
    legs.every((leg, index) => leg.floorId === expectedFloors[index]) &&
    progression.finalFloorId === legs.at(-1)!.floorId &&
    (last.outcome !== 'victory' ||
      progression.winnableFloorIds.every((id) =>
        legs.some((leg) => leg.floorId === id && leg.stats.outcome === 'victory'),
      )) &&
    (!progression.reachedFinalVictory ||
      progression.winnableFloorIds.every((id) =>
        legs.some((leg) => leg.floorId === id && leg.stats.outcome === 'victory'),
      ));
  const complete =
    chainValid &&
    runs.every(
      (run, index) =>
        run.outcome !== 'error' &&
        (index === runs.length - 1 || run.outcome === 'victory') &&
        valid(run.gameTimeMs) &&
        valid(run.safeRoomMs) &&
        run.safeRoomMs <= run.gameTimeMs &&
        valid(run.totalFrames) &&
        run.evaluationContext?.source === first.evaluationContext?.source &&
        run.evaluationContext?.seed === first.evaluationContext?.seed &&
        run.evaluationContext?.startFloor === legs[index]!.floorId,
    ) &&
    Math.abs(sum((run) => run.gameTimeMs) - base.gameTimeMs) < 0.001 &&
    Math.abs(sum((run) => run.safeRoomMs) - base.safeRoomMs) < 0.001 &&
    sum((run) => run.totalFrames) === base.totalFrames;
  // Preserve valid single-floor telemetry only after validating chain completeness.
  if (runs.length === 1 && complete) return base;
  const covered = (key: keyof NonNullable<RunStats['evaluationContext']>['available']): boolean =>
    complete && runs.every((run) => run.evaluationContext?.available[key] === true);
  const combat =
    covered('combat') &&
    runs.every((run) =>
      [run.combat.totalKills, run.combat.damageDealt, run.combat.damageTaken].every(valid),
    );
  const health =
    covered('health') &&
    runs.every(
      (run) =>
        [run.health.minHealthPercent, run.health.finalHealthPercent].every(
          (v) => valid(v) && v <= 1,
        ) && [run.health.closeCallCount, run.health.lowHealthCount].every(valid),
    );
  const progressionAvailable =
    covered('progression') &&
    runs.every(
      (run) =>
        [run.totalXp, run.runStartXp, run.finalLevel, run.runStartLevel].every(valid) &&
        run.totalXp >= run.runStartXp! &&
        run.finalLevel >= run.runStartLevel! &&
        run.levelUps.every(
          (event) =>
            valid(event.gameTimeMs) &&
            event.gameTimeMs <= run.gameTimeMs &&
            valid(event.frame) &&
            event.frame <= run.totalFrames,
        ),
    );
  const quests =
    covered('quests') &&
    runs.every((run) => [run.quests.questsAccepted, run.quests.questsCompleted].every(valid));
  const sumMap = (read: (run: RunStats) => Record<string, number>): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const run of runs)
      for (const [key, value] of Object.entries(read(run))) {
        result[key] = (result[key] ?? 0) + value;
      }
    return result;
  };
  let gameOffset = 0;
  let activeOffset = 0;
  let frameOffset = 0;
  const levelUps: RunStats['levelUps'] = [];
  const events: NonNullable<RunStats['rewardEvents']>['events'][number][] = [];
  const accepts: Record<string, number> = {};
  const completions: Record<string, number> = {};
  const failed: string[] = [];
  let firstQuestCompletedMs: number | null = null;
  let mainQuestAcceptedMs: number | null = null;
  let mainQuestCompletedMs: number | null = null;
  const rewardsComplete =
    complete &&
    runs.every(
      (run) =>
        run.rewardEvents &&
        valid(run.rewardEvents.activeDurationMs) &&
        Math.abs(run.rewardEvents.activeDurationMs - (run.gameTimeMs - run.safeRoomMs)) < 0.001 &&
        run.rewardEvents.events.every(
          (event) =>
            valid(event.gameTimeMs) &&
            event.gameTimeMs <= run.gameTimeMs &&
            valid(event.activeTimeMs) &&
            event.activeTimeMs <= run.rewardEvents!.activeDurationMs,
        ),
    );
  for (const [index, run] of runs.entries()) {
    const prefix = `${index}:${legs[index]!.floorId}:`;
    levelUps.push(
      ...run.levelUps.map((event) => ({
        ...event,
        gameTimeMs: event.gameTimeMs + gameOffset,
        frame: event.frame + frameOffset,
      })),
    );
    if (rewardsComplete)
      events.push(
        ...run.rewardEvents!.events.map((event) => ({
          ...event,
          sourceId: prefix + event.sourceId,
          gameTimeMs: event.gameTimeMs + gameOffset,
          activeTimeMs: event.activeTimeMs + activeOffset,
        })),
      );
    for (const [key, time] of Object.entries(run.quests.questLogAccepts))
      accepts[prefix + key] = time + gameOffset;
    for (const [key, time] of Object.entries(run.quests.questLogCompletions))
      completions[prefix + key] = time + gameOffset;
    failed.push(...run.quests.questsFailed.map((id) => prefix + id));
    if (firstQuestCompletedMs === null && run.quests.firstQuestCompletedMs !== null)
      firstQuestCompletedMs = run.quests.firstQuestCompletedMs + gameOffset;
    if (mainQuestAcceptedMs === null && run.quests.mainQuestAcceptedMs !== null)
      mainQuestAcceptedMs = run.quests.mainQuestAcceptedMs + gameOffset;
    if (run.quests.mainQuestCompletedMs !== null)
      mainQuestCompletedMs = run.quests.mainQuestCompletedMs + gameOffset;
    gameOffset += run.gameTimeMs;
    activeOffset += run.gameTimeMs - run.safeRoomMs;
    frameOffset += run.totalFrames;
  }
  return {
    ...base,
    startingWeapon: first.startingWeapon,
    playerPersona: first.playerPersona,
    evaluationContext: first.evaluationContext
      ? {
          ...first.evaluationContext,
          available: { combat, health, progression: progressionAvailable, quests },
        }
      : undefined,
    combat: {
      totalKills: sum((run) => run.combat.totalKills),
      damageDealt: sum((run) => run.combat.damageDealt),
      damageTaken: sum((run) => run.combat.damageTaken),
      killsByType: sumMap((run) => run.combat.killsByType),
      damageTakenBySource: sumMap((run) => run.combat.damageTakenBySource),
      combatTimeMs: sum((run) => run.combat.combatTimeMs),
      engagementCount: sum((run) => run.combat.engagementCount),
    },
    health: {
      minHealthPercent: Math.min(...runs.map((run) => run.health.minHealthPercent)),
      finalHealthPercent: last.health.finalHealthPercent,
      closeCallCount: sum((run) => run.health.closeCallCount),
      lowHealthCount: sum((run) => run.health.lowHealthCount),
    },
    quests: {
      questsAccepted: sum((run) => run.quests.questsAccepted),
      questsCompleted: sum((run) => run.quests.questsCompleted),
      questsFailed: failed,
      questLogAccepts: accepts,
      questLogCompletions: completions,
      firstQuestCompletedMs,
      mainQuestAcceptedMs,
      mainQuestCompletedMs,
    },
    levelUps,
    runStartXp: first.runStartXp,
    runStartLevel: first.runStartLevel,
    // Synthetic endpoints preserve the evaluator's end-minus-start contract.
    // Raw terminal levels/XP remain available in chainedLegs.
    totalXp: progressionAvailable
      ? first.runStartXp! + sum((run) => run.totalXp - run.runStartXp!)
      : last.totalXp,
    finalLevel: progressionAvailable
      ? first.runStartLevel! + sum((run) => run.finalLevel - run.runStartLevel!)
      : last.finalLevel,
    rewardEvents: rewardsComplete ? { activeDurationMs: activeOffset, events } : undefined,
    // Sampled movement lacks its precise observation-duration denominator.
    // Item choices include setup/carryover selections; adding them fabricates choices.
    // Preserve these and all other floor-local optional diagnostics only in legs.
    movementQuality: undefined,
    itemInteractions: undefined,
    runPerformance: undefined,
    equipmentPlayability: undefined,
    aiTelemetry: undefined,
    spawnerArenas: undefined,
    weaponTelemetry: undefined,
    abilityTelemetry: undefined,
    lootEfficiency: undefined,
    goldEconomy: undefined,
    vendors: undefined,
    skills: undefined,
    metaProgression: undefined,
    xpOnGroundAtEnd: undefined,
    familyTrashKills: undefined,
    denBoss: undefined,
    floor1BossProgression: undefined,
    floor2Progression: undefined,
    floor3Progression: undefined,
    floor4Arena: undefined,
    floor5Siege: undefined,
    floor6Defense: undefined,
  };
}
