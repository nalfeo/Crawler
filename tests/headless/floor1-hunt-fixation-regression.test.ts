import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import { AIDecisionMode, AIPathingMode } from '../../src/game/ai/types.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../src/game/ai/floor1-run-budget.js';

const MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;
const MAX_WALL_TIME_MS = 170_000;
const TEST_TIMEOUT_MS = MAX_WALL_TIME_MS * 2 + 20_000;

describe('Floor 1 tutorial hunt fixation regression', () => {
  it(
    'sword seed 14 escapes the unreachable-target stall and wins within budget',
    async () => {
      const seed = 14;
      const weapon = 'sword';
      const run = () =>
        runHeadless(
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
      const stats = await run();
      const replay = await run();

      expect(stats.startingWeapon).toBe(weapon);
      expect(stats.quests.questLogCompletions['floor1-tutorial']).toBeDefined();
      expect(stats.combat.totalKills).toBeGreaterThan(0);
      expect(stats.outcome).toBe('victory');
      expect(isOfficialWin(stats, FLOOR1_ACTIVE_TIME_BUDGET_MS)).toBe(true);
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
