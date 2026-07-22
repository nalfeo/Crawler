/**
 * SLACK_AWARE decision-mode (A/B axis 2) tests.
 *
 * Contract under test (the ONLY real behavior change in the harness):
 *   - Defaults are LEGACY for both A/B axes, so a default-constructed AI is
 *     byte-identical to main.
 *   - The SLACK_AWARE monotone filters (F1 optional-goal suppression, F2
 *     exit-commitment) are STRICT no-ops unless the AI is in SLACK_AWARE mode
 *     AND this frame's run plan is time-pressured. In LEGACY, or in SLACK_AWARE
 *     while not urgent, the opening decision is identical to LEGACY.
 *   - The urgency gate (`isRunPlanUrgent`) is pure and boundary-correct.
 *   - MONOTONICITY: forcing urgency must NOT reshuffle the high-priority Track A
 *     ladder (Retreat > ArenaLockin > Interact > Progress); the opening Progress
 *     decision on a fresh Floor-1 world is unchanged even when urgent. (The full
 *     win-rate monotonicity gate is the headless legacy-vs-slackAware A/B; a lab
 *     alone is insufficient for behavior claims — see repo rule #10.)
 */

import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { isRunPlanUrgent } from '../../../src/game/ai/run-planner.js';
import { spawnPlayer } from '../../../src/core/spawners/combatants.js';
import { spawnGold } from '../../../src/core/helpers.js';
import { acceptQuest } from '../../../src/core/systems/questSystem.js';
import { FLOOR1_TUTORIAL_QUEST_ID } from '../../../src/shared/quest-types.js';
import { createInputState } from '../../../src/shared/input.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../../src/game/floorScenario.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import {
  AIDecisionMode,
  AIPathingMode,
  AIState,
  type AIDecision,
} from '../../../src/game/ai/types.js';

function freshFloor1World(seed: number): ReturnType<typeof createTestWorld> {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  return world;
}

function decisionShape(d: AIDecision): {
  state: AIDecision['state'];
  targetEid: number | null;
  targetX: number | null;
  targetY: number | null;
  reason: string;
} {
  return {
    state: d.state,
    targetEid: d.targetEid,
    targetX: d.targetX,
    targetY: d.targetY,
    reason: d.reason,
  };
}

describe('isRunPlanUrgent — pure gate math', () => {
  it('a null plan is never urgent', () => {
    expect(isRunPlanUrgent(null, 0.66)).toBe(false);
  });

  it('negative slack is urgent regardless of urgency value', () => {
    expect(isRunPlanUrgent({ urgency: 0, slackMs: -1 }, 0.66)).toBe(true);
    expect(isRunPlanUrgent({ urgency: 0.1, slackMs: -0.0001 }, 0.66)).toBe(true);
  });

  it('urgency at/above the threshold is urgent even with positive slack', () => {
    expect(isRunPlanUrgent({ urgency: 0.66, slackMs: 100_000 }, 0.66)).toBe(true);
    expect(isRunPlanUrgent({ urgency: 0.9, slackMs: 100_000 }, 0.66)).toBe(true);
  });

  it('urgency just below the threshold with positive slack is NOT urgent', () => {
    expect(isRunPlanUrgent({ urgency: 0.65, slackMs: 100_000 }, 0.66)).toBe(false);
    expect(isRunPlanUrgent({ urgency: 0, slackMs: 100_000 }, 0.66)).toBe(false);
  });
});

describe('AI A/B axes — getters + defaults', () => {
  it('defaults to the production AI Sweep winner (pathing=riskRewardFused, decision=legacy)', () => {
    const ai = new BehaviorTreeAI({ seed: 42 });
    expect(ai.getPathingMode()).toBe(AIPathingMode.RISK_REWARD_FUSED);
    expect(ai.getDecisionMode()).toBe(AIDecisionMode.LEGACY);
  });

  it('preserves pre-promotion byte-identical behavior when LEGACY is explicitly requested', () => {
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.LEGACY });
    expect(ai.getPathingMode()).toBe(AIPathingMode.LEGACY);
    expect(ai.getDecisionMode()).toBe(AIDecisionMode.LEGACY);
  });

  it('echoes explicitly-configured modes', () => {
    const ai = new BehaviorTreeAI({
      seed: 42,
      pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      decisionMode: AIDecisionMode.SLACK_AWARE,
    });
    expect(ai.getPathingMode()).toBe(AIPathingMode.RISK_REWARD_FUSED);
    expect(ai.getDecisionMode()).toBe(AIDecisionMode.SLACK_AWARE);
  });
});

describe('SLACK_AWARE — inert unless urgent (LEGACY parity)', () => {
  for (const seed of [42, 7, 123]) {
    it(`opening decision matches LEGACY when the run plan is not urgent (seed ${seed})`, () => {
      // Fresh Floor-1 world: the generous default deadline keeps the opening
      // run plan well inside its slack window, so SLACK_AWARE must not diverge.
      const legacyWorld = freshFloor1World(seed);
      const slackWorld = freshFloor1World(seed);

      const legacyAi = new BehaviorTreeAI({ seed, decisionMode: AIDecisionMode.LEGACY });
      const slackAi = new BehaviorTreeAI({ seed, decisionMode: AIDecisionMode.SLACK_AWARE });

      legacyAi.poll(createInputState(), legacyWorld);
      slackAi.poll(createInputState(), slackWorld);

      // Sanity: the opening plan is genuinely non-urgent so this is a real
      // "inert filter" assertion, not a vacuous one.
      const slackPlan = slackAi.getTacticalRunDebug().runPlan;
      if (slackPlan) {
        expect(isRunPlanUrgent(slackPlan, 0.66)).toBe(false);
      }

      expect(decisionShape(slackAi.getDecision())).toEqual(decisionShape(legacyAi.getDecision()));
    });
  }

  it('pathing RISK_REWARD_FUSED does not change the opening goal-level decision (pathing is below the decision ladder)', () => {
    // RISK_REWARD_FUSED is IMPLEMENTED (not a no-op): it re-scores the FINAL
    // movement heading against sampled danger/reward AFTER the BT decision is
    // made. So the goal-level decision shape (state/target/reason) on the opening
    // poll is pathing-invariant, even though the emitted heading may differ. The
    // real behavioral divergence is proven by the headless legacy-vs-fused A/B
    // (npm run ai:ab-pathing-mode) — a lab/unit poll alone is insufficient for
    // behavior claims (repo rule #10).
    const seed = 42;
    const legacyWorld = freshFloor1World(seed);
    const fusedWorld = freshFloor1World(seed);

    const legacyAi = new BehaviorTreeAI({ seed, pathingMode: AIPathingMode.LEGACY });
    const fusedAi = new BehaviorTreeAI({ seed, pathingMode: AIPathingMode.RISK_REWARD_FUSED });

    legacyAi.poll(createInputState(), legacyWorld);
    fusedAi.poll(createInputState(), fusedWorld);

    expect(decisionShape(fusedAi.getDecision())).toEqual(decisionShape(legacyAi.getDecision()));
  });
});

describe('SLACK_AWARE — urgency detection + monotone high-priority ladder', () => {
  it('detects a blown deadline as urgent, yet leaves the opening Progress decision unchanged', () => {
    const seed = 42;

    // LEGACY reference on a world with the SAME blown deadline: proves the
    // high-priority ladder (Progress) is deadline-blind and that SLACK_AWARE's
    // urgency does not reshuffle it (monotone — no win→loss reshuffle risk).
    const legacyWorld = freshFloor1World(seed);
    const urgentWorld = freshFloor1World(seed);
    for (const w of [legacyWorld, urgentWorld]) {
      // Collapse the remaining budget below the estimated required time so
      // slackMs goes strongly negative → urgent. Frame-based, deterministic.
      w.floorScenario!.objective.deadlineMs = w.elapsedMs + 1;
    }

    const legacyAi = new BehaviorTreeAI({ seed, decisionMode: AIDecisionMode.LEGACY });
    const urgentAi = new BehaviorTreeAI({ seed, decisionMode: AIDecisionMode.SLACK_AWARE });

    legacyAi.poll(createInputState(), legacyWorld);
    urgentAi.poll(createInputState(), urgentWorld);

    // The travel run plan the AI is reading is genuinely urgent this frame.
    const plan = urgentAi.getTacticalRunDebug().runPlan;
    expect(plan).not.toBeNull();
    if (plan) {
      expect(plan.slackMs).toBeLessThan(0);
      expect(isRunPlanUrgent(plan, 0.66)).toBe(true);
    }

    // Monotone: Progress (priority 4) outranks Collect/Hunt/Explore, and the F1
    // guards only suppress those lower-priority optional goals. So the opening
    // Progress decision is byte-identical between LEGACY and urgent SLACK_AWARE.
    expect(decisionShape(urgentAi.getDecision())).toEqual(decisionShape(legacyAi.getDecision()));
  });
});

describe('SLACK_AWARE — F1 observable suppression of an optional goal', () => {
  // The parity tests above prove F1 is inert when the winning goal is Progress.
  // This test proves F1 actually DOES something when the opening goal IS optional:
  // it constructs a world whose LEGACY opening decision is COLLECT, then shows
  // SLACK_AWARE suppresses it under urgency — and, critically, falls back to
  // EXPLORE rather than stranding the agent (discovery is never lost). This is
  // the "activation evidence" the plan review asked for; the win-rate A/B on
  // healthy Floor-1 is inert precisely because urgency rarely fires there.
  function collectOpeningWorld(seed: number): ReturnType<typeof createTestWorld> {
    const world = createTestWorld({ seed });
    const player = spawnPlayer(world, 0, 0);
    // Real Floor-1 scenario/objective so the run-plan estimator has a deadline to
    // blow. Urgency requires floorScenario + a fully-shaped objective (bossBattles,
    // positions, kill counts) — a hand-built objective would be brittle, so we use
    // the real initializer and only override what we need below.
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    // Accept the tutorial so findProgressObjective takes the level-1 grind branch,
    // which returns NO explicit Progress target — leaving the opportunistic Collect
    // goal as the winning (lower-priority) Track A goal in LEGACY.
    acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
    // Gold placed directly under the player so it is collectable without any A*
    // reachability (isLootCollectable short-circuits within DIRECT_MOVE_EPSILON_FT).
    // This makes the COLLECT precondition robust to whatever procedural map the
    // scenario generated (initializeFloor1Scenario also relocated the player to the
    // map spawn, so read the post-move position rather than assuming (0,0)).
    const px = world.stores.position.x[player] ?? 0;
    const py = world.stores.position.y[player] ?? 0;
    spawnGold(world, px, py, 3);
    return world;
  }

  it('LEGACY collects the nearby gold; urgent SLACK_AWARE suppresses Collect and explores instead', () => {
    const seed = 42;
    const legacyWorld = collectOpeningWorld(seed);
    const urgentWorld = collectOpeningWorld(seed);
    // Blow the deadline in BOTH worlds so the ONLY difference is the decision
    // mode, not the world state (frame-based, deterministic). Mark the staircase
    // DISCOVERED so LEGACY's collapse-panic beeline self-disables (its gate is
    // `!staircaseDiscovered`, bt-ai-provider.ts:427) — otherwise the LEGACY beeline
    // would ALSO suppress Collect and the two modes would be indistinguishable.
    // This is exactly the "farms forever after discovering the stairs" gap that F1
    // is designed to close: LEGACY stops beelining once stairs are seen, F1 does
    // not stop suppressing optional goals under urgency.
    for (const w of [legacyWorld, urgentWorld]) {
      w.floorScenario!.objective.deadlineMs = w.elapsedMs + 1;
      w.floorScenario!.objective.staircaseDiscovered = true;
    }

    const legacyAi = new BehaviorTreeAI({ seed, decisionMode: AIDecisionMode.LEGACY });
    const urgentAi = new BehaviorTreeAI({ seed, decisionMode: AIDecisionMode.SLACK_AWARE });

    legacyAi.poll(createInputState(), legacyWorld);
    urgentAi.poll(createInputState(), urgentWorld);

    // Precondition: LEGACY (deadline-blind for optional goals) still collects the
    // gold — proving the opening goal is genuinely the optional Collect goal.
    expect(legacyAi.getDecision().state).toBe(AIState.COLLECT);

    // The urgency the F1 filters actually read this frame is genuinely urgent.
    const plan = urgentAi.getTacticalRunDebug().decisionRunPlan;
    expect(plan).not.toBeNull();
    if (plan) {
      expect(isRunPlanUrgent(plan, 0.66)).toBe(true);
    }

    // F1 monotone suppression: the optional Collect goal is removed under urgency,
    // and the agent falls back to Explore (discovery is NOT stranded — no
    // dead-end, no loss-inducing stall).
    expect(urgentAi.getDecision().state).not.toBe(AIState.COLLECT);
    expect(urgentAi.getDecision().state).toBe(AIState.EXPLORE);
  });
});
