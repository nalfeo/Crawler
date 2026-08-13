import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import { AIDecisionMode, AIPathingMode } from '../../src/game/ai/types.js';
import type { SimEvent } from '../../src/game/ai/event-log.js';
import { GAME } from '../../src/shared/constants.js';

const MAX_FRAMES = 23_760;
const MAX_GAME_TIME_MS = MAX_FRAMES * GAME.DELTA_MS;
const BOSS_LOCKIN_MAX_FRAMES = 19_800;
const BOSS_LOCKIN_MAX_GAME_TIME_MS = BOSS_LOCKIN_MAX_FRAMES * GAME.DELTA_MS;
const BOSS_LOCKIN_MAX_FIGHT_FRAMES = Math.ceil((60_000 / 1000) * 60);
const BOSS_ENTRY_MIN_HEALTH_FRACTION = 0.5;
const BOSS_ENTRY_MIN_LEVEL = 2;
const MAX_WALL_TIME_MS = 170_000;
const CASES = [
  { weapon: 'pistol', seed: 30 },
  { weapon: 'throwing-knife', seed: 2 },
  { weapon: 'throwing-knife', seed: 6 },
  { weapon: 'throwing-knife', seed: 81 },
  { weapon: 'throwing-knife', seed: 84 },
] as const;
const BOSS_LOCKIN_CASES = [
  { weapon: 'baseball-bat', seed: 2 },
  { weapon: 'baseball-bat', seed: 25 },
  { weapon: 'sword', seed: 44 },
  { weapon: 'baseball-bat', seed: 67 },
] as const;
const FLOOR1_BOSS_IDS = ['slime-rat', 'staircase'] as const;

describe('Floor 1 legacy weapon-sweep death regressions', () => {
  for (const { weapon, seed } of CASES) {
    it(`${weapon} seed ${seed} is an official victory`, async () => {
      const stats = await runHeadless(
        new BehaviorTreeAI({
          seed,
          pathingMode: AIPathingMode.RISK_REWARD_FUSED,
          decisionMode: AIDecisionMode.LEGACY,
        }),
        {
          seed,
          maxFrames: MAX_FRAMES,
          maxWallTimeMs: MAX_WALL_TIME_MS,
          forceWeaponId: weapon,
        },
      );

      expect(stats.startingWeapon).toBe(weapon);
      expect(stats.outcome).toBe('victory');
      expect(isOfficialWin(stats, MAX_GAME_TIME_MS)).toBe(true);
    });
  }
});

describe('Floor 1 boss-entry readiness and arena lock-in regressions', () => {
  for (const { weapon, seed } of BOSS_LOCKIN_CASES) {
    it(
      `${weapon} seed ${seed} enters ready, locks onto both bosses, and wins within the sweep budget`,
      async () => {
        const events: SimEvent[] = [];
        const stats = await runHeadless(
          new BehaviorTreeAI({
            seed,
            pathingMode: AIPathingMode.RISK_REWARD_FUSED,
            decisionMode: AIDecisionMode.LEGACY,
          }),
          {
            seed,
            maxFrames: BOSS_LOCKIN_MAX_FRAMES,
            maxWallTimeMs: MAX_WALL_TIME_MS,
            forceWeaponId: weapon,
            // Record every decision frame: the lock-in assertion below needs the
            // exact frame a boss becomes the target, which the default 15-frame
            // sample interval can skip.
            eventSampleInterval: 1,
            recordEvent: (event) => events.push(event),
          },
        );

        expect(stats.startingWeapon).toBe(weapon);
        expect(stats.outcome).toBe('victory');
        expect(isOfficialWin(stats, BOSS_LOCKIN_MAX_GAME_TIME_MS)).toBe(true);

        const progression = stats.floor1BossProgression;
        expect(progression, 'floor1BossProgression must be present on Floor 1').toBeDefined();
        for (const bossId of FLOOR1_BOSS_IDS) {
          const encounter = progression!.encounters[bossId];
          if (!encounter) {
            throw new Error(`Missing ${bossId} encounter telemetry`);
          }
          expect(encounter.encounterStarted, `${bossId} never started`).toBe(true);
          expect(encounter.encounterDefeated, `${bossId} never completed`).toBe(true);
          expect(encounter.bossEid, `${bossId} did not capture its boss eid`).not.toBeNull();
          expect(
            encounter.playerLevelAtStart,
            `${bossId} started below the minimum readiness level`,
          ).toBeGreaterThanOrEqual(BOSS_ENTRY_MIN_LEVEL);
          expect(
            encounter.playerHealthFractionAtStart,
            `${bossId} started below the minimum readiness health`,
          ).toBeGreaterThanOrEqual(BOSS_ENTRY_MIN_HEALTH_FRACTION);

          const fightFrames =
            (encounter.encounterDefeatedFrame ?? Number.POSITIVE_INFINITY) -
            (encounter.encounterStartedFrame ?? 0);
          expect(
            fightFrames,
            `${bossId} remained locked for ${fightFrames} frames`,
          ).toBeLessThanOrEqual(BOSS_LOCKIN_MAX_FIGHT_FRAMES);

          const bossTargetEvents = events.filter(
            (event) =>
              event.reason.startsWith('Boss-room lock-in') && event.targetEid === encounter.bossEid,
          );
          expect(
            bossTargetEvents.length,
            `${bossId} never became the explicit arena lock-in target`,
          ).toBeGreaterThan(0);
        }
      },
      10 * 60 * 1000,
    );
  }
});
