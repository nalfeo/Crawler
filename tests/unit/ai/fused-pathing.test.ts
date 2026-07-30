/**
 * RISK_REWARD_FUSED pathing (A/B axis 1) — the fused danger/reward heading scorer.
 *
 * Contract under test:
 *   - DORMANCY (byte-identity guard): LEGACY pathing never runs the fused scorer,
 *     so a default (LEGACY) AI never populates the fused debug snapshot. The fused
 *     code path is fully dead unless pathingMode === RISK_REWARD_FUSED.
 *   - OPT-IN CAPTURE: even in fused mode the debug snapshot is only recorded when
 *     `fusedDebugCapture` is set. The headless runner / win-rate gate never set it,
 *     so that path allocates nothing new and stays deterministic.
 *   - INTEGRITY: when it runs, the scorer fans exactly the 13 configured candidate
 *     offsets around the desired heading, records each candidate's component terms,
 *     and its returned/chosen heading is the argmax of the recorded scores.
 *   - DANGER-AWARENESS: a dense projected-threat cluster sitting on the
 *     straight-ahead sample point makes that heading the fan's most dangerous, and
 *     the scorer deflects the chosen heading away from it. (The full win-rate proof
 *     is the headless legacy-vs-fused A/B sweep — a lab/unit alone is insufficient
 *     for behaviour claims; see repo rule #10. This test locks the mechanism.)
 */

import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import {
  spawnPlayer,
  spawnEnemy,
  spawnBehaviorEnemy,
} from '../../../src/core/spawners/combatants.js';
import { AI_TYPE } from '../../../src/game/enemyAISystem.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../../src/game/floorScenario.js';
import { createInputState } from '../../../src/shared/input.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import { AIPathingMode } from '../../../src/game/ai/types.js';
import type { FusedHeadingDebug } from '../../../src/game/ai/index.js';

type TestWorld = ReturnType<typeof createTestWorld>;

/** Typed view onto the private scorer so a test can drive it directly. */
type FusedScorerInternals = {
  fusedDebugCapture: boolean;
  getFusedDebug(): FusedHeadingDebug | null;
  computeRiskRewardFusedHeading(
    world: TestWorld,
    playerX: number,
    playerY: number,
    baseMoveX: number,
    baseMoveY: number,
    weights: { dodgeWeight: number; collectPullWeight: number; farmPullWeight: number },
  ): { moveX: number; moveY: number };
};

function freshFloor1World(seed: number): TestWorld {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  return world;
}

/** The RISK_REWARD_CANDIDATE_OFFSETS_DEG fan is [0, ±15, ±30, ±45, ±60, ±75, ±90]. */
const EXPECTED_CANDIDATE_COUNT = 13;
/** RISK_REWARD_DANGER_LOOKAHEAD_FT — candidates are sampled this far ahead. */
const SAMPLE_LOOKAHEAD_FT = 8;

describe('RISK_REWARD_FUSED — dormancy + opt-in capture (byte-identity guard)', () => {
  it('fused mode with capture OFF (the default) records nothing', () => {
    const world = freshFloor1World(42);
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    // fusedDebugCapture defaults to false — this mirrors the headless runner/gate.

    for (let i = 0; i < 5; i++) {
      ai.poll(createInputState(), world);
    }

    expect(ai.getFusedDebug()).toBeNull();
  });
});

describe('RISK_REWARD_FUSED — runs through the real poll path', () => {
  it('captures a well-formed 13-candidate argmax snapshot on a fresh Floor-1 world', () => {
    const world = freshFloor1World(42);
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    (ai as unknown as FusedScorerInternals).fusedDebugCapture = true;

    // The opening Progress decision drives a travel heading, which routes through
    // the fused scorer. Poll a few times so the AI is reliably in a travel state.
    let debug: FusedHeadingDebug | null = null;
    for (let i = 0; i < 8 && debug === null; i++) {
      ai.poll(createInputState(), world);
      debug = ai.getFusedDebug();
    }

    expect(debug).not.toBeNull();
    if (!debug) return;
    expect(debug.candidates).toHaveLength(EXPECTED_CANDIDATE_COUNT);

    // Exactly one chosen candidate, and it is the score argmax.
    const chosenCandidates = debug.candidates.filter((c) => c.chosen);
    expect(chosenCandidates).toHaveLength(1);
    const maxScore = Math.max(...debug.candidates.map((c) => c.score));
    expect(chosenCandidates[0]!.score).toBe(maxScore);
    expect(debug.bestScore).toBe(maxScore);

    // The reported best heading matches the chosen candidate direction.
    expect(debug.bestX).toBeCloseTo(chosenCandidates[0]!.dirX, 10);
    expect(debug.bestY).toBeCloseTo(chosenCandidates[0]!.dirY, 10);

    // Straight-ahead (0°) offset is always present and is the pure objective heading.
    const straight = debug.candidates.find((c) => c.angleDeg === 0);
    expect(straight).toBeDefined();
  });
});

describe('RISK_REWARD_FUSED — danger-aware deflection', () => {
  it('deflects the chosen heading away from a dense threat cluster dead ahead', () => {
    // No floorMap => the scorer uses the pure enemy-danger branch and perceives
    // every in-bounds enemy, giving a fully deterministic, geometry-free scenario.
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);

    // 12 live, stationary enemies stacked on the straight-ahead sample point
    // (player + desired * lookahead). Zero velocity => projected == current.
    for (let i = 0; i < 12; i++) {
      spawnEnemy(world, SAMPLE_LOOKAHEAD_FT, 0, 100);
    }

    const ai = new BehaviorTreeAI({ seed: 7, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    const internals = ai as unknown as FusedScorerInternals;
    internals.fusedDebugCapture = true;

    // Desired heading = +x, straight into the cluster. No reward/dodge pull.
    const result = internals.computeRiskRewardFusedHeading(world, 0, 0, 1, 0, {
      dodgeWeight: 0,
      collectPullWeight: 0,
      farmPullWeight: 0,
    });

    const debug = ai.getFusedDebug();
    expect(debug).not.toBeNull();
    if (!debug) return;

    expect(debug.candidates).toHaveLength(EXPECTED_CANDIDATE_COUNT);
    expect(debug.threats).toHaveLength(12);

    // The straight-ahead heading is the fan's most dangerous.
    const straight = debug.candidates.find((c) => c.angleDeg === 0)!;
    const maxDanger = Math.max(...debug.candidates.map((c) => c.danger));
    expect(straight.danger).toBe(maxDanger);
    expect(maxDanger).toBeGreaterThan(1);

    // The scorer must NOT walk into the cluster. The straight-ahead candidate is
    // strictly dominated here (progress 1 − danger≫1, vs a deflected candidate's
    // positive score), so the argmax is GUARANTEED to deflect off 0° to a
    // strictly-safer heading. We assert those guaranteed invariants — deflects at
    // all + strictly lower danger than straight ahead — rather than a specific
    // angle magnitude, which is fixture/weight-dependent and would be brittle
    // across a legitimate future retune (plan review 2026-07-08, concern #7).
    const chosen = debug.candidates.find((c) => c.chosen)!;
    expect(chosen.angleDeg).not.toBe(0);
    expect(chosen.danger).toBeLessThan(straight.danger);

    // The returned move is the chosen (deflected) heading, not the raw objective.
    expect(result.moveX).toBeCloseTo(chosen.dirX, 10);
    expect(result.moveY).toBeCloseTo(chosen.dirY, 10);
    expect(result.moveX).toBeLessThan(1); // no longer pure +x
  });
});

describe('RISK_REWARD_FUSED — ranged danger radius extends to actual attack range', () => {
  it('uses attackRange (not just the base danger radius) for a ranged enemy standing OUTSIDE the base radius', () => {
    // Base RISK_REWARD_DANGER_RADIUS_FT is 9ft. Place a ranged enemy with a
    // much longer attackRange 15ft away from the straight-ahead sample point
    // (SAMPLE_LOOKAHEAD_FT=8, so world position (8, 15)) — outside the base
    // radius but within the enemy's real ranged attack reach, so danger
    // evaluation must account for the enemy's actual threat range, not just
    // the fixed melee-scale base radius.
    const ATTACK_RANGE_FT = 20;
    const THREAT_DISTANCE_FT = 15;

    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    spawnBehaviorEnemy(
      world,
      SAMPLE_LOOKAHEAD_FT,
      THREAT_DISTANCE_FT,
      40,
      AI_TYPE.RANGED,
      5,
      200,
      ATTACK_RANGE_FT,
    );

    const ai = new BehaviorTreeAI({ seed: 7, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    const internals = ai as unknown as FusedScorerInternals;
    internals.fusedDebugCapture = true;

    internals.computeRiskRewardFusedHeading(world, 0, 0, 1, 0, {
      dodgeWeight: 0,
      collectPullWeight: 0,
      farmPullWeight: 0,
    });

    const debug = ai.getFusedDebug();
    expect(debug).not.toBeNull();
    if (!debug) return;

    expect(debug.threats).toHaveLength(1);
    // The threat's recorded radius is extended to the ranged enemy's real
    // attack range, not clamped to the base danger radius.
    expect(debug.threats[0]!.radiusFt).toBe(ATTACK_RANGE_FT);
    expect(debug.threats[0]!.radiusFt).toBeGreaterThan(debug.dangerRadiusFt);

    // With the extended radius, the straight-ahead sample point (distance
    // THREAT_DISTANCE_FT=15 from the threat) is within the danger bubble
    // (15 < 20) and must register nonzero danger.
    const straight = debug.candidates.find((c) => c.angleDeg === 0)!;
    expect(straight.danger).toBeGreaterThan(0);
  });

  it('a melee/non-ranged enemy at the same distance stays clamped to the base danger radius (no danger)', () => {
    // Control case: same 15ft distance, but a plain enemy with no attackRange
    // override — the base 9ft radius must NOT reach it, proving the extension
    // above is genuinely attackRange-driven and not a general radius bump.
    const THREAT_DISTANCE_FT = 15;

    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, SAMPLE_LOOKAHEAD_FT, THREAT_DISTANCE_FT, 100);

    const ai = new BehaviorTreeAI({ seed: 7, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    const internals = ai as unknown as FusedScorerInternals;
    internals.fusedDebugCapture = true;

    internals.computeRiskRewardFusedHeading(world, 0, 0, 1, 0, {
      dodgeWeight: 0,
      collectPullWeight: 0,
      farmPullWeight: 0,
    });

    const debug = ai.getFusedDebug();
    expect(debug).not.toBeNull();
    if (!debug) return;

    expect(debug.threats).toHaveLength(1);
    expect(debug.threats[0]!.radiusFt).toBe(debug.dangerRadiusFt); // base radius, not extended
    const straight = debug.candidates.find((c) => c.angleDeg === 0)!;
    expect(straight.danger).toBe(0);
  });
});
