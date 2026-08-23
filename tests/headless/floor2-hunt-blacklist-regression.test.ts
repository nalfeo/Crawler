import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

const MAX_FRAMES = 80_000;
const MAX_WALL_TIME_MS = 240_000;
const TEST_TIMEOUT_MS = MAX_WALL_TIME_MS * 2 + 20_000;

/**
 * Regression for a Floor 2 stall where `updateEngageWatchdog`'s "give up on
 * an unreachable ENGAGE target" blacklist (`ignoredEnemyUntilFrame`) was
 * silently ineffective for family-hunt targeting: `findNearestFloor2HuntEnemy`
 * (and `findNearestFloor2Boss`) never checked the blacklist, so the exact
 * enemy the watchdog just gave up on (still the nearest family member) was
 * immediately re-selected next tick. That reset the watchdog's per-eid
 * baseline and repeated the giveup cycle forever — seed 3 (sword) fixated on
 * a single `llamas` enemy wedged against geometry near (343, 377) for a
 * single continuous ~163s stuck episode, stalling den progress at 3/50 kills
 * and timing out well before Floor 2 exit.
 *
 * Fixed by honoring `ignoredEnemyUntilFrame` inside
 * `findNearestFloor2HuntEnemy`'s and `findNearestFloor2Boss`'s candidate
 * filters, mirroring the existing pattern in `findNearestEnemy` /
 * `findNearestQuestEnemy`.
 */
describe('Floor 2 hunt-target blacklist regression', () => {
  it(
    'seed 107 relocates from blocked family targets and completes every den',
    async () => {
      const seed = 107;
      const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
        seed,
        floorId: 'floor2',
        maxFrames: MAX_FRAMES,
        maxWallTimeMs: MAX_WALL_TIME_MS,
      });

      expect(stats.outcome).toBe('victory');
      const families = Object.values(stats.floor2Progression?.families ?? {});
      expect(families).toHaveLength(4);
      expect(families.every((family) => family.encounterDefeated)).toBe(true);
      expect(stats.movementQuality?.stuckPct ?? 100).toBeLessThan(20);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sword seed 3 does not fixate on a blacklisted llamas target and wins within budget',
    async () => {
      const seed = 3;
      const weapon = 'sword';
      const run = () =>
        runHeadless(new BehaviorTreeAI({ seed }), {
          seed,
          floorId: 'floor2',
          maxFrames: MAX_FRAMES,
          maxWallTimeMs: MAX_WALL_TIME_MS,
          forceWeaponId: weapon,
        });
      const stats = await run();
      const replay = await run();

      expect(stats.outcome).toBe('victory');
      expect(stats.familyTrashKills?.llamas ?? 0).toBeGreaterThanOrEqual(50);

      // The fixed defect manifested as ~41% of the run stuck fixated on one
      // unreachable llamas target. Guard against regressing back toward that
      // shape (the fixed run measures well under 25%).
      expect(stats.movementQuality?.stuckPct ?? 0).toBeLessThan(25);

      expect({
        outcome: replay.outcome,
        totalFrames: replay.totalFrames,
        gameTimeMs: replay.gameTimeMs,
        finalScore: replay.finalScore,
        finalLevel: replay.finalLevel,
        totalXp: replay.totalXp,
        totalGold: replay.totalGold,
        combat: replay.combat,
        health: replay.health,
        quests: replay.quests,
        aiTelemetry: replay.aiTelemetry,
      }).toEqual({
        outcome: stats.outcome,
        totalFrames: stats.totalFrames,
        gameTimeMs: stats.gameTimeMs,
        finalScore: stats.finalScore,
        finalLevel: stats.finalLevel,
        totalXp: stats.totalXp,
        totalGold: stats.totalGold,
        combat: stats.combat,
        health: stats.health,
        quests: stats.quests,
        aiTelemetry: stats.aiTelemetry,
      });
    },
    TEST_TIMEOUT_MS,
  );
});
