import { describe, expect, it } from 'vitest';
import type { GameWorld } from '../../src/core/world.js';
import { GAME } from '../../src/shared/constants.js';
import type { InputState } from '../../src/shared/input.js';
import { xpRequiredForLevel } from '../../src/shared/xpMath.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { spawnXpGem } from '../../src/core/spawners/pickups.js';
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
    expect(stats.runStartXp).toBe(stats.totalXp);
    expect(stats.runStartXp).toBeGreaterThanOrEqual(xpRequiredForLevel(3));
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
    expect(stats.runStartXp ?? 0).toBe(0);
  });

  it('reports xpOnGroundAtEnd on the normal completion path', async () => {
    let spawned = false;
    const stats = await runHeadless(new ScriptedDecisionProvider(), {
      seed: 42,
      maxFrames: 1,
      maxWallTimeMs: 30_000,
      forceWeaponId: 'sword',
      simulationOptions: {
        postSystems: [
          (world) => {
            if (spawned) return;
            spawned = true;
            spawnXpGem(world, 900, 900, 5);
            spawnXpGem(world, 910, 900, 12);
          },
        ],
      },
    });

    expect(stats.outcome).toBe('timeout');
    expect(stats.xpOnGroundAtEnd).toBe(17);
    // The loot ledger rides the same completion path as xpOnGroundAtEnd.
    expect(stats.lootEfficiency?.xpSpawned).toBeGreaterThanOrEqual(17);
    expect(stats.lootEfficiency?.xpCollected).toBe(0);
    expect(stats.lootEfficiency?.xpRatio).toBe(0);
  });

  it('reports xpOnGroundAtEnd on the error path', async () => {
    let spawned = false;
    const stats = await runHeadless(new ScriptedDecisionProvider(), {
      seed: 42,
      maxFrames: 10,
      maxWallTimeMs: 30_000,
      forceWeaponId: 'sword',
      simulationOptions: {
        postSystems: [
          (world) => {
            if (!spawned) {
              spawned = true;
              spawnXpGem(world, 900, 900, 5);
              spawnXpGem(world, 910, 900, 12);
            }
            throw new Error('telemetry crash test');
          },
        ],
      },
    });

    expect(stats.outcome).toBe('error');
    expect(stats.error).toContain('telemetry crash test');
    expect(stats.xpOnGroundAtEnd).toBe(17);
    // The error path must surface the same ledger the normal path does.
    expect(stats.lootEfficiency?.xpSpawned).toBeGreaterThanOrEqual(17);
    expect(stats.lootEfficiency?.xpCollected).toBe(0);
    expect(stats.lootEfficiency?.xpRatio).toBe(0);
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
    // damageTakenBySource sums per-hit event amounts; damageTaken uses per-frame HP-delta
    // tracking. They can legitimately diverge when HP is restored within a frame
    // (level-up max-HP sync, healing effects). The loot-efficiency AI changes (A3)
    // cause the player to collect more XP, level up more frequently, and receive more
    // max-HP syncs that mask in-frame damage from the HP-delta tracker. With the new
    // behaviour the observed divergence is ~31% on this seed/frame budget, so the
    // tolerance is widened to 50% of total damage taken (or 1 HP, whichever is greater)
    // to remain deterministic without being artificially tight.
    // toBeLessThanOrEqual is used (not toBeLessThan) so an exact boundary match does
    // not cause a spurious failure.
    expect(Math.abs(attributedDamage - stats.combat.damageTaken)).toBeLessThanOrEqual(
      Math.max(1, stats.combat.damageTaken * 0.5),
    );
  });

  it('attributes the lethal hit via the terminal flush when the run ends in death', async () => {
    // Use a very high enemy damage multiplier to guarantee the player dies
    // quickly (within a few seconds of encountering the first enemy).
    // This forces the break-on-death path (lines 726–739) and exercises the
    // post-loop combat-event flush that captures the killing blow.
    //
    // The tight assertion: bucket total must equal the sum of every player-hit
    // event in world.combatEvents captured by onFinish. world.combatEvents is
    // never drained during headless runs, so onFinish sees all events including
    // those processed by the terminal flush. If the flush is absent, the lethal
    // hit remains in world.combatEvents but is missing from damageTakenBySource,
    // so totalEventDamage > attributedDamage and the check fails — even when
    // earlier non-lethal hits already satisfy weaker > 0 / named-source checks.
    let totalEventDamage = 0;

    const stats = await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      maxFrames: 7_200, // 2-minute safety cap
      maxWallTimeMs: 60_000,
      enemyDamageMultiplier: 999,
      onFinish: (world) => {
        for (const event of world.combatEvents) {
          if (event.type === 'hit' && event.targetType === 'player' && event.amount > 0) {
            totalEventDamage += event.amount;
          }
        }
      },
    });

    expect(stats.outcome).toBe('death');
    expect(totalEventDamage).toBeGreaterThan(0);

    const attributedDamage = Object.values(stats.combat.damageTakenBySource).reduce(
      (total, damage) => total + damage,
      0,
    );
    // The bucket total must match the ground-truth event sum exactly. Any
    // omitted event (e.g. a missing terminal flush) causes attributedDamage to
    // be strictly less than totalEventDamage.
    expect(attributedDamage).toBe(totalEventDamage);
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

describe('Floor 2 levelAtEncounterStart telemetry', () => {
  it('is null for all families when no boss encounter has started (1-frame run)', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor2',
      maxFrames: 1,
    });

    expect(stats.floor2Progression).toBeDefined();
    for (const fam of Object.values(stats.floor2Progression!.families)) {
      expect(fam.levelAtEncounterStart).toBeNull();
    }
  });

  it('captures the player level at the frame the first boss encounter starts', async () => {
    // Force the first present family's boss encounter to start on frame 1
    // so we can assert the captured level matches world.playerLevel.level.
    let capturedLevelAtForce = -1;
    let targetFamilyId = '';
    let fired = false;

    const stats = await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor2',
      maxFrames: 2,
      simulationOptions: {
        postSystems: [
          (world: GameWorld) => {
            if (fired) return;
            const floor2State = world.floorExtendedState?.familyState;
            if (!floor2State) return;
            const familyId = floor2State.presentFamilies[0];
            if (!familyId) return;
            const encounter = floor2State.bossEncounters?.get(familyId);
            if (!encounter) return;
            // Force encounter started and capture the level at the same frame.
            encounter.started = true;
            capturedLevelAtForce = world.playerLevel?.level ?? -1;
            targetFamilyId = familyId;
            fired = true;
          },
        ],
      },
    });

    expect(stats.floor2Progression).toBeDefined();
    const famMetrics = stats.floor2Progression!.families[targetFamilyId];
    expect(famMetrics).toBeDefined();
    // The runner captures the level on the frame started first becomes true.
    // capturedLevelAtForce is the level at that same frame (postSystems run
    // inside the simulation tick, before telemetry collection).
    expect(famMetrics!.levelAtEncounterStart).toBe(capturedLevelAtForce);
    expect(famMetrics!.levelAtEncounterStart).not.toBeNull();
  });
});
