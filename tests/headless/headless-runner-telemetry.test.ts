import { describe, expect, it } from 'vitest';
import type { GameWorld } from '../../src/core/world.js';
import { GAME } from '../../src/shared/constants.js';
import type { InputState } from '../../src/shared/input.js';
import { xpRequiredForLevel } from '../../src/shared/xpMath.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import {
  AIDecisionDebugState,
  AIProgressSuppressionSource,
  AIState,
  type AIDecision,
  type AIInputProvider,
} from '../../src/game/ai/types.js';

class ScriptedDecisionProvider implements AIInputProvider {
  private frame = 0;
  private decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'scripted explore',
    debug: null,
  };

  poll(_state: InputState, _world: GameWorld): void {
    this.frame += 1;
    this.decision =
      this.frame === 2
        ? {
            state: AIState.EXPLORE,
            targetEid: null,
            targetX: null,
            targetY: null,
            reason: 'scripted suppressed fallback',
            debug: {
              state: AIDecisionDebugState.SUPPRESSED_PROGRESS_NAV,
              reason: 'progressGoalSuppressed',
              source: AIProgressSuppressionSource.EXPLORE_DWELL_FIXED_POSITION_TARGET,
              criticalChainPhase: 'pre-chain',
              blockedTargetReason: 'Seeking scripted progress target',
              suppressedUntilFrame: 10,
              remainingFrames: 8,
            },
          }
        : {
            state: AIState.EXPLORE,
            targetEid: null,
            targetX: null,
            targetY: null,
            reason: 'scripted explore',
            debug: null,
          };
  }

  getDecision(): AIDecision {
    return {
      ...this.decision,
      debug: this.decision.debug ? { ...this.decision.debug } : null,
    };
  }

  reset(): void {
    this.frame = 0;
  }
}

describe('headless runner AI telemetry', () => {
  it('rolls up telemetry-only decision labels into run stats', async () => {
    const stats = await runHeadless(new ScriptedDecisionProvider(), {
      seed: 42,
      maxFrames: 3,
      maxWallTimeMs: 30_000,
      forceWeaponId: 'sword',
    });

    expect(stats.aiTelemetry).toEqual({
      decisionStateCounts: {
        EXPLORE: 2,
        suppressedProgressNav: 1,
      },
      decisionStateMs: {
        EXPLORE: 2 * GAME.DELTA_MS,
        suppressedProgressNav: GAME.DELTA_MS,
      },
      suppressedProgressNavCount: 1,
      suppressedProgressNavMs: GAME.DELTA_MS,
    });
  });

  it('supports jumping to an arbitrary player level at run start', async () => {
    const stats = await runHeadless(new ScriptedDecisionProvider(), {
      seed: 42,
      maxFrames: 0,
      maxWallTimeMs: 30_000,
      startPlayerLevel: 3,
      forceWeaponId: 'sword',
    });

    expect(stats.finalLevel).toBeGreaterThanOrEqual(3);
    expect(stats.totalXp).toBeGreaterThanOrEqual(xpRequiredForLevel(3));
  });

  it('level 1 (default) applies no boost', async () => {
    const stats = await runHeadless(new ScriptedDecisionProvider(), {
      seed: 42,
      maxFrames: 0,
      maxWallTimeMs: 30_000,
      startPlayerLevel: 1,
      forceWeaponId: 'sword',
    });

    // No boost applied — player XP/level should not be inflated above a normal start.
    expect(stats.finalLevel).toBeLessThan(2);
  });
});
