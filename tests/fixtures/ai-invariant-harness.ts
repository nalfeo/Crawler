import { describe, expect, it } from 'vitest';
import type { InputState } from '../../src/shared/input.js';
import type { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import {
  AIDecisionMode,
  AIPathingMode,
  type AIDecisionModeValue,
  type AIPathingModeValue,
} from '../../src/game/ai/types.js';

export const AI_INVARIANT = {
  OBJECTIVE_ROUTING: 'objective-routing',
  DOOR_STATE_REPLAN: 'door-state-replan',
  NPC_INTERACTION_ANCHOR: 'npc-interaction-anchor',
  PARTIAL_PATH_REJECTION: 'partial-path-rejection',
  CRITICAL_ROUTE_OWNERSHIP: 'critical-route-ownership',
  COMMITTED_DETOUR_ACCOUNTING: 'committed-detour-accounting',
  STALL_RECOVERY: 'stall-recovery',
} as const;

export type AIInvariantId = (typeof AI_INVARIANT)[keyof typeof AI_INVARIANT];

export interface AIInvariantAxis {
  readonly decisionMode: AIDecisionModeValue;
  readonly pathingMode: AIPathingModeValue;
}

export const SLICE_A_DECISION_AXES: readonly AIInvariantAxis[] = [
  {
    decisionMode: AIDecisionMode.LEGACY,
    pathingMode: AIPathingMode.RISK_REWARD_FUSED,
  },
] as const;

export interface AILocomotionInvariantContract {
  /**
   * Locomotion modes for which this case supplies a concrete assertion. A
   * downstream locomotion slice extends the same invariant id with another case
   * instead of creating a parallel harness.
   */
  readonly assertedPathingModes: readonly AIPathingModeValue[];
  readonly owner: 'slice-a' | 'downstream';
}

export interface AIInvariantTrace {
  readonly decision: {
    readonly state: number;
    readonly targetEid: number | null;
    readonly targetX: number | null;
    readonly targetY: number | null;
    readonly reason: string;
    readonly npcInteraction: {
      readonly npcEid: number;
      readonly action: string;
      readonly allowWhileExploring: boolean;
    } | null;
    readonly debugState: string | null;
  };
  readonly effectiveRunPlan: {
    readonly source: 'decision' | 'travel' | 'none';
    readonly routeHeadId: string | null;
    readonly nextActionableGoalId: string | null;
    readonly urgency: number | null;
    readonly slackMs: number | null;
  };
  readonly movement: {
    readonly x: number;
    readonly y: number;
  };
  readonly markers: Readonly<Record<string, unknown>>;
}

export interface AIInvariantCase {
  readonly id: string;
  readonly invariant: AIInvariantId;
  readonly axes: readonly AIInvariantAxis[];
  readonly locomotion?: AILocomotionInvariantContract;
  /**
   * Runs one seed-complete fixture and asserts its activation preconditions plus
   * behavior. The harness runs it twice and compares the full returned trace.
   */
  readonly run: (axis: AIInvariantAxis) => AIInvariantTrace;
}

export interface AIInvariantCoverageRow {
  readonly invariant: AIInvariantId;
  readonly decisionMode: AIDecisionModeValue;
  readonly applicableCases: number;
}

const ALL_INVARIANTS = Object.values(AI_INVARIANT);
const ALL_DECISION_MODES = [AIDecisionMode.LEGACY] as const;

function sameAxis(left: AIInvariantAxis, right: AIInvariantAxis): boolean {
  return left.decisionMode === right.decisionMode && left.pathingMode === right.pathingMode;
}

function getAiInvariantCoverage(
  cases: readonly AIInvariantCase[],
): readonly AIInvariantCoverageRow[] {
  return ALL_INVARIANTS.flatMap((invariant) =>
    ALL_DECISION_MODES.map((decisionMode) => ({
      invariant,
      decisionMode,
      applicableCases: cases.filter(
        (testCase) =>
          testCase.invariant === invariant &&
          testCase.axes.some((axis) => axis.decisionMode === decisionMode),
      ).length,
    })),
  );
}

export function captureAiInvariantTrace(
  ai: BehaviorTreeAI,
  input: InputState,
  markers: Readonly<Record<string, unknown>> = {},
): AIInvariantTrace {
  const decision = ai.getDecision();
  const runDebug = ai.getTacticalRunDebug();
  const effectiveRunPlan = runDebug.decisionRunPlan ?? runDebug.runPlan;
  const source =
    runDebug.decisionRunPlan !== null ? 'decision' : runDebug.runPlan !== null ? 'travel' : 'none';

  return {
    decision: {
      state: decision.state,
      targetEid: decision.targetEid,
      targetX: decision.targetX,
      targetY: decision.targetY,
      reason: decision.reason,
      npcInteraction: decision.npcInteraction
        ? {
            npcEid: decision.npcInteraction.npcEid,
            action: decision.npcInteraction.action,
            allowWhileExploring: decision.npcInteraction.allowWhileExploring,
          }
        : null,
      debugState: decision.debug?.state ?? null,
    },
    effectiveRunPlan: {
      source,
      routeHeadId: effectiveRunPlan?.routeHeadId ?? null,
      nextActionableGoalId: effectiveRunPlan?.nextActionableGoalId ?? null,
      urgency: effectiveRunPlan?.urgency ?? null,
      slackMs: effectiveRunPlan?.slackMs ?? null,
    },
    movement: {
      x: input.moveX,
      y: input.moveY,
    },
    markers,
  };
}

export function defineAiInvariantSuite(cases: readonly AIInvariantCase[]): void {
  const duplicateCaseIds = cases
    .map((testCase) => testCase.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateCaseIds.length > 0) {
    throw new Error(`Duplicate AI invariant case ids: ${duplicateCaseIds.join(', ')}`);
  }

  const coverage = getAiInvariantCoverage(cases);

  describe('AI invariant applicability contract', () => {
    it('covers every hard-gate invariant in legacy mode', () => {
      const uncovered = coverage.filter((row) => row.applicableCases === 0);
      expect(
        uncovered.map((row) => `${row.invariant}/${row.decisionMode}`),
        'AI invariant matrix has uncovered cells',
      ).toEqual([]);
    });

    for (const testCase of cases) {
      if (!testCase.locomotion) continue;
      it(`${testCase.id} declares an owned locomotion assertion`, () => {
        expect(testCase.locomotion?.assertedPathingModes.length).toBeGreaterThan(0);
        for (const axis of testCase.axes) {
          expect(testCase.locomotion?.assertedPathingModes).toContain(axis.pathingMode);
        }
      });
    }
  });

  describe('deterministic AI invariant matrix', () => {
    for (const testCase of cases) {
      for (const axis of testCase.axes) {
        it(`${testCase.invariant} :: ${testCase.id} :: ${axis.decisionMode}/${axis.pathingMode}`, () => {
          const canonicalAxis = SLICE_A_DECISION_AXES.find((candidate) =>
            sameAxis(candidate, axis),
          );
          expect(
            canonicalAxis,
            `Case ${testCase.id} uses an undeclared Slice A axis: ${axis.decisionMode}/${axis.pathingMode}`,
          ).toBeDefined();

          const first = testCase.run(axis);
          const replay = testCase.run(axis);
          expect(replay).toEqual(first);
        });
      }
    }
  });
}
