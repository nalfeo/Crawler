import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { FLOOR1_LEAVE_FLOOR_QUEST_ID } from '../../src/shared/quest-types.js';

function deterministicStats(stats: RunStats): Omit<RunStats, 'wallTimeMs'> {
  const { wallTimeMs: _wallTimeMs, ...deterministic } = stats;
  return deterministic;
}

async function runBaseballBat34(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 34 }), {
    seed: 34,
    maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: 300_000,
    forceWeaponId: 'baseball-bat',
  });
}

describe('Floor 1 local threat recovery', () => {
  it('clears baseball-bat seed 34 after a low-health recovery and remains deterministic', async () => {
    const first = await runBaseballBat34();
    const second = await runBaseballBat34();

    expect(first.startingWeapon).toBe('baseball-bat');
    expect(first.outcome).toBe('victory');
    expect(first.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
    expect(isOfficialWin(first, FLOOR1_ACTIVE_TIME_BUDGET_MS)).toBe(true);
    expect(first.health.lowHealthCount).toBeGreaterThan(0);
    expect(first.aiTelemetry).toBeDefined();
    expect(first.aiTelemetry!.decisionStateCounts.RETREAT).toBeGreaterThan(0);
    expect(first.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
    expect(deterministicStats(second)).toEqual(deterministicStats(first));
  }, 180_000);
});
