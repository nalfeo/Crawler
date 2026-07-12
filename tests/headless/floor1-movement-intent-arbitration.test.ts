import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import type { SimEvent } from '../../src/game/ai/event-log.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { MovementIntentOwner } from '../../src/game/ai/movement-intent-arbiter.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { NPC_INTERACTION_RADIUS_FT } from '../../src/game/ai/bt-ai-tuning.js';
import { GAME } from '../../src/shared/constants.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
  FLOOR1_MEET_NPCS_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
} from '../../src/shared/quest-types.js';

const FLOOR1_TIME_BUDGET_MS = 360_000;
const MAX_FRAMES = Math.ceil((FLOOR1_TIME_BUDGET_MS * 1.1) / GAME.DELTA_MS);
const MAX_WALL_TIME_MS = 170_000;
const EGRESS_DEADLINE_MS = 10_000;
const STABLE_EGRESS_DEADLINE_MS = 15_000;
const MIN_OUTSIDE_STREAK_MS = 3_000;
const MAX_EGRESS_REBOUNDS = 1;

const REQUIRED_QUEST_IDS = [
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_MEET_NPCS_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
] as const;

const CASES = [
  { seed: 74, weapon: 'bow', badTransitionAfterMs: 0 },
  { seed: 74, weapon: 'pistol', badTransitionAfterMs: 0 },
  { seed: 49, weapon: 'throwing-knife', badTransitionAfterMs: 20_000 },
] as const;

interface BossSnapshot {
  slimeRatStarted: boolean;
  slimeRatDefeated: boolean;
  staircaseStarted: boolean;
  staircaseDefeated: boolean;
}

interface ComparatorProbe {
  stats: RunStats;
  events: SimEvent[];
  samples: SimEvent[];
  identifiedEgressMs: number;
  firstExitMs: number;
  outsideStreakMs: number;
  egressReboundCount: number;
  bosses: BossSnapshot;
}

interface StableOutsideTransition {
  readonly outsideStreakMs: number;
  readonly reboundCount: number;
}

function findStableOutsideTransition(
  samples: readonly SimEvent[],
  firstExitMs: number,
  identifiedEgressMs: number,
  startDeadlineMs: number,
  requiredStreakMs: number,
): StableOutsideTransition {
  let index = samples.findIndex(
    (sample) => sample.gameMs >= firstExitMs && sample.inSafe === false,
  );
  let bestMs = 0;
  let reboundCount = 0;

  while (index >= 0 && index < samples.length) {
    const outsideStartMs = samples[index]!.gameMs;
    if (outsideStartMs - identifiedEgressMs > startDeadlineMs) break;

    let outsideStreakMs = 0;
    while (index < samples.length && samples[index]!.inSafe === false) {
      const sample = samples[index]!;
      const next = samples[index + 1];
      outsideStreakMs += next ? Math.max(0, next.gameMs - sample.gameMs) : 0;
      index += 1;
    }
    bestMs = Math.max(bestMs, outsideStreakMs);
    if (outsideStreakMs >= requiredStreakMs) {
      return { outsideStreakMs, reboundCount };
    }

    if (index < samples.length) {
      reboundCount += 1;
      while (index < samples.length && samples[index]!.inSafe !== false) {
        index += 1;
      }
    }
  }

  return { outsideStreakMs: bestMs, reboundCount };
}

async function runComparator(
  seed: number,
  weapon: string,
  badTransitionAfterMs: number,
): Promise<ComparatorProbe> {
  const events: SimEvent[] = [];
  const bosses: BossSnapshot = {
    slimeRatStarted: false,
    slimeRatDefeated: false,
    staircaseStarted: false,
    staircaseDefeated: false,
  };
  const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
    seed,
    forceWeaponId: weapon,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: MAX_WALL_TIME_MS,
    eventSampleInterval: 10,
    recordEvent: (event) => events.push(event),
    onFinish: (world) => {
      const slimeRat = world.floorScenario?.objective?.bossBattles.get('slime-rat');
      const staircase = world.floorScenario?.objective?.bossBattles.get('staircase');
      bosses.slimeRatStarted = slimeRat?.started === true;
      bosses.slimeRatDefeated = slimeRat?.defeated === true;
      bosses.staircaseStarted = staircase?.started === true;
      bosses.staircaseDefeated = staircase?.defeated === true;
    },
  });
  const samples = events.filter((event) => event.type === 'sample');
  const identifiedEgress = events.find(
    (event) =>
      event.gameMs >= badTransitionAfterMs &&
      event.inSafe === true &&
      event.movementIntent?.owner === MovementIntentOwner.SAFE_ROOM_EGRESS &&
      event.movementIntent.transition === 'acquired',
  );
  if (!identifiedEgress) {
    throw new Error(`seed ${seed} · ${weapon} never acquired the identified egress transition`);
  }
  const firstExit = samples.find(
    (sample) => sample.gameMs >= identifiedEgress.gameMs && sample.inSafe === false,
  );
  if (!firstExit) {
    throw new Error(`seed ${seed} · ${weapon} never exited safe space after egress acquisition`);
  }
  const stableOutside = findStableOutsideTransition(
    samples,
    firstExit.gameMs,
    identifiedEgress.gameMs,
    STABLE_EGRESS_DEADLINE_MS,
    MIN_OUTSIDE_STREAK_MS,
  );

  return {
    stats,
    events,
    samples,
    identifiedEgressMs: identifiedEgress.gameMs,
    firstExitMs: firstExit.gameMs,
    outsideStreakMs: stableOutside.outsideStreakMs,
    egressReboundCount: stableOutside.reboundCount,
    bosses,
  };
}

describe('Floor 1 movement-intent arbitration comparators', () => {
  for (const { seed, weapon, badTransitionAfterMs } of CASES) {
    describe(`seed ${seed} · ${weapon}`, () => {
      let probe: ComparatorProbe;

      beforeAll(async () => {
        probe = await runComparator(seed, weapon, badTransitionAfterMs);
      }, 180_000);

      it('leaves safe space within the bounded egress transition and stays out', () => {
        expect(probe.firstExitMs - probe.identifiedEgressMs).toBeLessThanOrEqual(
          EGRESS_DEADLINE_MS,
        );
        expect(probe.outsideStreakMs).toBeGreaterThanOrEqual(MIN_OUTSIDE_STREAK_MS);
        expect(probe.egressReboundCount).toBeLessThanOrEqual(MAX_EGRESS_REBOUNDS);
      });

      it('never lets Retreat or Progression preempt a retained egress lease', () => {
        const illegalPreemption = probe.events.find(
          (event) =>
            event.type === 'movementIntent' &&
            event.movementIntent?.transition === 'preempted' &&
            event.movementIntent.priorOwner === MovementIntentOwner.SAFE_ROOM_EGRESS &&
            (event.movementIntent.owner === MovementIntentOwner.RETREAT ||
              event.movementIntent.owner === MovementIntentOwner.PROGRESSION),
        );
        expect(illegalPreemption).toBeUndefined();
        expect(probe.stats.aiTelemetry?.inSafeMovementIntentViolationCount).toBe(0);
      });

      it('completes quests and both boss battles through the real headless pipeline', () => {
        for (const questId of REQUIRED_QUEST_IDS) {
          const acceptedAt = probe.stats.quests.questLogAccepts[questId];
          const completedAt = probe.stats.quests.questLogCompletions[questId];
          expect(acceptedAt, `${questId} was not accepted`).toBeTypeOf('number');
          expect(completedAt, `${questId} was not completed`).toBeTypeOf('number');
          expect(completedAt!, `${questId} completed before acceptance`).toBeGreaterThanOrEqual(
            acceptedAt!,
          );
        }
        expect(probe.bosses).toEqual({
          slimeRatStarted: true,
          slimeRatDefeated: true,
          staircaseStarted: true,
          staircaseDefeated: true,
        });
      });

      it('keeps interactions in range and records an official win', () => {
        const interactionDistances = probe.samples
          .filter((sample) => sample.state === 'INTERACT' && sample.targetDist !== null)
          .map((sample) => sample.targetDist!);
        expect(interactionDistances.length).toBeGreaterThan(0);
        expect(Math.max(...interactionDistances)).toBeLessThan(NPC_INTERACTION_RADIUS_FT);
        expect(
          isOfficialWin(probe.stats, FLOOR1_TIME_BUDGET_MS),
          `${probe.stats.outcome}@${(probe.stats.gameTimeMs / 1000).toFixed(1)}s`,
        ).toBe(true);
      });
    });
  }
});
