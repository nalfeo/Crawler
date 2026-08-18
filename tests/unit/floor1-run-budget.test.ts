import { describe, expect, it } from 'vitest';
import { GAME } from '../../src/shared/constants.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
  planningDeadlineMsFromFrameBudget,
  resolveFloor1PlanningDeadlineMs,
} from '../../src/game/ai/floor1-run-budget.js';

describe('Floor 1 run budget', () => {
  it('derives the raw runner deadline from the exact frame budget', () => {
    expect(planningDeadlineMsFromFrameBudget(FLOOR1_DEFAULT_MAX_FRAMES)).toBe(
      FLOOR1_DEFAULT_MAX_FRAMES * GAME.DELTA_MS,
    );
    expect(planningDeadlineMsFromFrameBudget(0)).toBeNull();
    expect(() => planningDeadlineMsFromFrameBudget(-1)).toThrow(/non-negative safe integer/);
    expect(() => planningDeadlineMsFromFrameBudget(1.5)).toThrow(/non-negative safe integer/);
  });

  it('never plans past the collapse deadline or runner cap', () => {
    expect(resolveFloor1PlanningDeadlineMs(600_000)).toBe(FLOOR1_ACTIVE_TIME_BUDGET_MS);
    expect(resolveFloor1PlanningDeadlineMs(630_000)).toBe(FLOOR1_ACTIVE_TIME_BUDGET_MS + 30_000);
    expect(resolveFloor1PlanningDeadlineMs(300_000)).toBe(300_000);
    expect(resolveFloor1PlanningDeadlineMs(600_000, 120_000)).toBe(120_000);
  });

  it('lets a reused BehaviorTreeAI replace and clear its runner cap', () => {
    const ai = new BehaviorTreeAI({ seed: 42 });
    expect(ai.resolveFloor1PlanningDeadlineMs(600_000)).toBe(FLOOR1_ACTIVE_TIME_BUDGET_MS);

    ai.configurePlanningDeadlineMs(120_000);
    expect(ai.resolveFloor1PlanningDeadlineMs(600_000)).toBe(120_000);

    ai.configurePlanningDeadlineMs(null);
    expect(ai.resolveFloor1PlanningDeadlineMs(600_000)).toBe(FLOOR1_ACTIVE_TIME_BUDGET_MS);
  });
});
