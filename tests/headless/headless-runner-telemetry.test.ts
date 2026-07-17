import { describe, expect, it } from 'vitest';
import type { GameWorld } from '../../src/core/world.js';
import { GAME } from '../../src/shared/constants.js';
import type { InputState } from '../../src/shared/input.js';
import { xpRequiredForLevel } from '../../src/shared/xpMath.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
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
    npcInteraction: null,
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
            npcInteraction: null,
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
            npcInteraction: null,
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

  it('counts real Floor 2 enemy deaths without treating director pruning as kills', async () => {
    let realEnemyDeaths = -1;
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor2',
      maxFrames: 3000,
      maxWallTimeMs: 60_000,
      forceWeaponId: 'sword',
      onFinish: (world) => {
        realEnemyDeaths = world.combatEvents.filter(
          (event) => event.type === 'death' && event.targetType === 'enemy',
        ).length;
      },
    });

    expect(realEnemyDeaths).toBeGreaterThan(0);
    expect(stats.combat.totalKills).toBe(realEnemyDeaths);
    expect(Object.values(stats.combat.killsByType).reduce((total, count) => total + count, 0)).toBe(
      realEnemyDeaths,
    );
    expect(stats.floor2Progression?.hunt.huntTimeMs).toBeGreaterThan(0);
    expect(stats.floor2Progression?.hunt.engageTimeMs).toBeGreaterThanOrEqual(0);
    expect(stats.floor2Progression?.hunt.engageRatio).toBeGreaterThanOrEqual(0);
    expect(stats.floor2Progression?.hunt.engageRatio).toBeLessThanOrEqual(1);
    const attributedDamage = Object.values(stats.combat.damageTakenBySource).reduce(
      (total, damage) => total + damage,
      0,
    );
    expect(attributedDamage).toBeGreaterThan(0);
    expect(Math.abs(attributedDamage - stats.combat.damageTaken)).toBeLessThan(0.05);
  });
});

describe('headless runner weapon telemetry (opt-in)', () => {
  it('is omitted from run stats by default (zero-cost, disabled channel)', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      maxFrames: 300,
      maxWallTimeMs: 30_000,
      forceWeaponId: 'sword',
    });

    expect(stats.weaponTelemetry).toBeUndefined();
  });

  it('collects deterministic, self-consistent weapon accuracy when enabled', async () => {
    const run = () =>
      runHeadless(new BehaviorTreeAI({ seed: 42 }), {
        seed: 42,
        maxFrames: 3000,
        maxWallTimeMs: 60_000,
        forceWeaponId: 'sword',
        recordWeaponTelemetry: true,
      });

    const stats = await run();
    const wt = stats.weaponTelemetry;
    expect(wt).toBeDefined();
    if (!wt) return; // narrow for TS; the assertion above already failed otherwise

    // The AI engages on seed 42, so the player must have swung at least once.
    expect(wt.swings).toBeGreaterThan(0);
    expect(wt.connectingSwings).toBeGreaterThan(0);

    // Internal consistency of the rollup.
    expect(wt.accuracyMisses).toBeLessThanOrEqual(wt.swings);
    expect(wt.connectingSwings).toBeLessThanOrEqual(wt.swings);
    expect(wt.multiHitSwings).toBeLessThanOrEqual(wt.connectingSwings);
    expect(wt.totalEnemyHits).toBeGreaterThanOrEqual(wt.connectingSwings);
    expect(wt.accuracy).toBeCloseTo(wt.connectingSwings / wt.swings, 10);
    expect(wt.multiHitRate).toBeCloseTo(wt.multiHitSwings / wt.connectingSwings, 10);
    expect(wt.avgEnemiesPerConnectingSwing).toBeCloseTo(
      wt.totalEnemyHits / wt.connectingSwings,
      10,
    );
    expect(wt.accuracy).toBeGreaterThan(0);
    expect(wt.accuracy).toBeLessThanOrEqual(1);

    // Same seed → identical telemetry (pure counting over a deterministic sim).
    const again = await run();
    expect(again.weaponTelemetry).toEqual(wt);
  });
});
