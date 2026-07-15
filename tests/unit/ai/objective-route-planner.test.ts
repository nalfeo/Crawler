import { describe, expect, it } from 'vitest';
import {
  IN_PLACE_LOCATION,
  MAX_GOAL_NODES,
  ObjectiveRoutePlannerError,
  planObjectiveRoute,
  type GoalNode,
  type TravelOracle,
} from '../../../src/game/ai/objective-route-planner.js';

/** Simple symmetric-distance oracle over a fixed location table, with an
 * optional set of "locked" edges that only open once a given effect tag is
 * satisfied (models a door). Returns Infinity for any pair not in the table
 * and for locked edges whose effect isn't yet satisfied — never a Euclidean
 * guess. */
function makeGraphOracle(
  edges: Record<string, Record<string, number>>,
  lockedEdges: Record<string, { to: string; effect: string }[]> = {},
): TravelOracle {
  return {
    travelCost(from, to, satisfiedEffects) {
      if (from === to) return 0;
      const locked = lockedEdges[from]?.find((e) => e.to === to);
      if (locked && !satisfiedEffects.has(locked.effect)) return Infinity;
      const lockedReverse = lockedEdges[to]?.find((e) => e.to === from);
      if (lockedReverse && !satisfiedEffects.has(lockedReverse.effect)) return Infinity;
      const direct = edges[from]?.[to];
      if (direct !== undefined) return direct;
      const reverse = edges[to]?.[from];
      if (reverse !== undefined) return reverse;
      return Infinity;
    },
  };
}

describe('planObjectiveRoute', () => {
  it('beats a fixed-source-order route on a non-colinear layout (global optimum)', () => {
    // Two spatial clusters: {A, B} cheaply connected to each other and to
    // start, {C, D} likewise, but crossing between clusters mid-route is
    // expensive (A<->C=9, B<->C=8, B<->D=9). The goals are declared in the
    // deliberately zigzag order [A, C, B, D] — a naive "visit in declared
    // order" scheduler would pay for two cluster crossings. The planner must
    // instead cluster same-neighborhood goals together (A,B then C,D),
    // crossing only once.
    const oracle = makeGraphOracle({
      start: { A: 1, C: 10 },
      A: { B: 1, C: 9 },
      B: { C: 8, D: 9 },
      C: { D: 1 },
    });
    const goals: GoalNode[] = [
      { id: 'goal-a', location: 'A', workCost: 0, prerequisiteIds: [], required: true },
      { id: 'goal-c', location: 'C', workCost: 0, prerequisiteIds: [], required: true },
      { id: 'goal-b', location: 'B', workCost: 0, prerequisiteIds: [], required: true },
      { id: 'goal-d', location: 'D', workCost: 0, prerequisiteIds: [], required: true },
    ];
    const route = planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle });

    // Global optimum re-clusters to [A, B, C, D]: 1 + 1 + 8 + 1 = 11.
    expect(route.steps.map((s) => s.goalId)).toEqual(['goal-a', 'goal-b', 'goal-c', 'goal-d']);
    expect(route.totalTravelMs).toBe(1 + 1 + 8 + 1);

    // The naive declared order [A, C, B, D] would cost 1 + 9 + 8 + 9 = 27 —
    // the planner's global optimum must beat it.
    const declaredOrderCost = 1 + 9 + 8 + 9;
    expect(route.totalMs).toBeLessThan(declaredOrderCost);
  });

  it('respects prerequisites (a goal cannot be scheduled before its prerequisite)', () => {
    const oracle = makeGraphOracle({ start: { A: 5, B: 1 }, A: { B: 1 }, B: { A: 1 } });
    const goals: GoalNode[] = [
      { id: 'first', location: 'B', workCost: 0, prerequisiteIds: [], required: true },
      { id: 'second', location: 'A', workCost: 0, prerequisiteIds: ['first'], required: true },
    ];
    const route = planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle });
    expect(route.steps.map((s) => s.goalId)).toEqual(['first', 'second']);
  });

  it('routes through a door only once the unlocking goal effect is satisfied', () => {
    // C is behind a door that only opens once "unlock-c" effect is satisfied,
    // which is granted by completing "open-door". Direct start->C is blocked
    // until then; start->open-door->C must be the chosen order.
    const oracle = makeGraphOracle(
      { start: { 'open-door': 1 }, 'open-door': { C: 1 } },
      { start: [{ to: 'C', effect: 'unlock-c' }] },
    );
    const goals: GoalNode[] = [
      {
        id: 'open-door',
        location: 'open-door',
        workCost: 0,
        prerequisiteIds: [],
        required: true,
        unlockEffects: ['unlock-c'],
      },
      { id: 'reach-c', location: 'C', workCost: 0, prerequisiteIds: [], required: true },
    ];
    const route = planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle });
    expect(route.steps.map((s) => s.goalId)).toEqual(['open-door', 'reach-c']);
    expect(Number.isFinite(route.totalMs)).toBe(true);
  });

  it('passes initial effects to the oracle even when no pending goal emits them', () => {
    const oracle = makeGraphOracle(
      { start: { A: 1 } },
      { start: [{ to: 'A', effect: 'already-unlocked' }] },
    );
    const goals: GoalNode[] = [
      { id: 'reach-a', location: 'A', workCost: 0, prerequisiteIds: [], required: true },
    ];

    const route = planObjectiveRoute({
      goals,
      startLocation: 'start',
      initialSatisfiedEffects: new Set(['already-unlocked']),
      travelOracle: oracle,
    });

    expect(route.steps.map((step) => step.goalId)).toEqual(['reach-a']);
  });

  it('throws a clear error rather than returning an Infinity-disguised success for a strictly unreachable required goal', () => {
    const oracle = makeGraphOracle({ start: { A: 1 } }); // B has no edges at all
    const goals: GoalNode[] = [
      { id: 'reach-a', location: 'A', workCost: 0, prerequisiteIds: [], required: true },
      { id: 'reach-b', location: 'B', workCost: 0, prerequisiteIds: [], required: true },
    ];
    expect(() =>
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle }),
    ).toThrow(ObjectiveRoutePlannerError);
    try {
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ObjectiveRoutePlannerError);
      expect((err as ObjectiveRoutePlannerError).code).toBe('unreachable-required-goal');
    }
  });

  it('treats work-only (in-place) goals as zero travel cost and location-preserving', () => {
    const oracle = makeGraphOracle({ start: { A: 5 } });
    const goals: GoalNode[] = [
      {
        id: 'grind',
        location: IN_PLACE_LOCATION,
        workCost: 1000,
        prerequisiteIds: [],
        required: true,
      },
      { id: 'reach-a', location: 'A', workCost: 0, prerequisiteIds: ['grind'], required: true },
    ];
    const route = planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle });
    expect(route.steps[0]).toMatchObject({ goalId: 'grind', travelMs: 0, workMs: 1000 });
    // Travel for reach-a is computed from the *real* prior location (start),
    // not from the in-place sentinel.
    expect(route.steps[1]).toMatchObject({ goalId: 'reach-a', travelMs: 5 });
    expect(route.totalMs).toBe(1005);
  });

  it('includes every optional bundle that fits within budget, maximizing bundle count', () => {
    const oracle = makeGraphOracle({
      start: { A: 1, B: 1, C: 1 },
      A: { B: 1, C: 1 },
      B: { C: 1 },
    });
    const goals: GoalNode[] = [
      { id: 'req', location: 'start', workCost: 0, prerequisiteIds: [], required: true },
      {
        id: 'opt-a',
        location: 'A',
        workCost: 1,
        prerequisiteIds: [],
        required: false,
        optionalBundleId: 'bundle-a',
      },
      {
        id: 'opt-b',
        location: 'B',
        workCost: 1,
        prerequisiteIds: [],
        required: false,
        optionalBundleId: 'bundle-b',
      },
      {
        id: 'opt-c',
        location: 'C',
        workCost: 1,
        prerequisiteIds: [],
        required: false,
        optionalBundleId: 'bundle-c',
      },
    ];
    const route = planObjectiveRoute({
      goals,
      startLocation: 'start',
      travelOracle: oracle,
      budgetMs: 1000, // generous — everything fits
    });
    expect(route.includedOptionalBundleIds).toEqual(['bundle-a', 'bundle-b', 'bundle-c']);
    expect(route.droppedOptionalBundleIds).toEqual([]);
    expect(route.requiredOverBudget).toBe(false);
  });

  it('drops optional bundles that do not fit, maximizing included bundle COUNT (not minimizing dropped work)', () => {
    const oracle = makeGraphOracle({ start: { A: 1, B: 100 } });
    const goals: GoalNode[] = [
      { id: 'req', location: 'start', workCost: 0, prerequisiteIds: [], required: true },
      // Two cheap bundles vs one expensive bundle: with a tight budget the
      // planner must prefer maximizing bundle COUNT (both cheap ones) over a
      // single expensive one, even though the expensive one alone might be
      // "closer" to using the full budget.
      {
        id: 'cheap-1',
        location: 'A',
        workCost: 1,
        prerequisiteIds: [],
        required: false,
        optionalBundleId: 'cheap-1',
      },
      {
        id: 'cheap-2',
        location: 'A',
        workCost: 1,
        prerequisiteIds: ['cheap-1'],
        required: false,
        optionalBundleId: 'cheap-2',
      },
      {
        id: 'expensive',
        location: 'B',
        workCost: 1,
        prerequisiteIds: [],
        required: false,
        optionalBundleId: 'expensive',
      },
    ];
    const route = planObjectiveRoute({
      goals,
      startLocation: 'start',
      travelOracle: oracle,
      budgetMs: 5, // fits both cheap bundles (1+1+1+1=4) but not the expensive one (100+1=101)
    });
    expect([...route.includedOptionalBundleIds].sort()).toEqual(['cheap-1', 'cheap-2']);
    expect(route.droppedOptionalBundleIds).toEqual(['expensive']);
  });

  it('never drops a required goal to fit budget; reports requiredOverBudget with negative slack', () => {
    const oracle = makeGraphOracle({ start: { A: 500 } });
    const goals: GoalNode[] = [
      { id: 'req', location: 'A', workCost: 0, prerequisiteIds: [], required: true },
    ];
    const route = planObjectiveRoute({
      goals,
      startLocation: 'start',
      travelOracle: oracle,
      budgetMs: 10,
    });
    expect(route.steps.map((s) => s.goalId)).toEqual(['req']);
    expect(route.totalMs).toBe(500);
    expect(route.requiredOverBudget).toBe(true);
  });

  it('throws on an unknown prerequisite id', () => {
    const oracle = makeGraphOracle({ start: { A: 1 } });
    const goals: GoalNode[] = [
      { id: 'a', location: 'A', workCost: 0, prerequisiteIds: ['does-not-exist'], required: true },
    ];
    expect(() =>
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle }),
    ).toThrow(ObjectiveRoutePlannerError);
    try {
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle });
    } catch (err) {
      expect((err as ObjectiveRoutePlannerError).code).toBe('unknown-prerequisite');
    }
  });

  it('throws on a cyclic dependency', () => {
    const oracle = makeGraphOracle({ start: { A: 1, B: 1 } });
    const goals: GoalNode[] = [
      { id: 'a', location: 'A', workCost: 0, prerequisiteIds: ['b'], required: true },
      { id: 'b', location: 'B', workCost: 0, prerequisiteIds: ['a'], required: true },
    ];
    expect(() =>
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle }),
    ).toThrow(ObjectiveRoutePlannerError);
    try {
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle });
    } catch (err) {
      expect((err as ObjectiveRoutePlannerError).code).toBe('cycle');
    }
  });

  it('throws when the pending-goal cardinality exceeds the cap', () => {
    const oracle: TravelOracle = { travelCost: () => 1 };
    const goals: GoalNode[] = Array.from({ length: MAX_GOAL_NODES + 1 }, (_, i) => ({
      id: `g${i}`,
      location: `L${i}`,
      workCost: 0,
      prerequisiteIds: [],
      required: true,
    }));
    expect(() =>
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle }),
    ).toThrow(ObjectiveRoutePlannerError);
    try {
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle });
    } catch (err) {
      expect((err as ObjectiveRoutePlannerError).code).toBe('node-cardinality-exceeded');
    }
  });

  it('throws on a duplicate goal id', () => {
    const oracle: TravelOracle = { travelCost: () => 1 };
    const goals: GoalNode[] = [
      { id: 'dup', location: 'A', workCost: 0, prerequisiteIds: [], required: true },
      { id: 'dup', location: 'B', workCost: 0, prerequisiteIds: [], required: true },
    ];
    expect(() =>
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle }),
    ).toThrow(ObjectiveRoutePlannerError);
  });

  it('breaks exact cost ties using stable lexicographic goal-id ordering, independent of input array order', () => {
    // Two equal-cost orderings exist (visit X then Y, or Y then X — symmetric
    // distances). The lexicographically smaller goal-id sequence must win
    // regardless of which order the caller lists the goals in.
    const oracle = makeGraphOracle({ start: { X: 3, Y: 3 }, X: { Y: 3 }, Y: { X: 3 } });
    const goalX: GoalNode = {
      id: 'goal-x',
      location: 'X',
      workCost: 0,
      prerequisiteIds: [],
      required: true,
    };
    const goalY: GoalNode = {
      id: 'goal-y',
      location: 'Y',
      workCost: 0,
      prerequisiteIds: [],
      required: true,
    };

    const routeA = planObjectiveRoute({
      goals: [goalX, goalY],
      startLocation: 'start',
      travelOracle: oracle,
    });
    const routeB = planObjectiveRoute({
      goals: [goalY, goalX],
      startLocation: 'start',
      travelOracle: oracle,
    });

    expect(routeA.steps.map((s) => s.goalId)).toEqual(['goal-x', 'goal-y']);
    expect(routeB.steps.map((s) => s.goalId)).toEqual(['goal-x', 'goal-y']);
  });

  it('exposes routeHeadId and nextActionableGoalId as the first step, or null for an empty route', () => {
    const oracle: TravelOracle = { travelCost: () => 1 };
    const empty = planObjectiveRoute({ goals: [], startLocation: 'start', travelOracle: oracle });
    expect(empty.routeHeadId).toBeNull();
    expect(empty.nextActionableGoalId).toBeNull();
    expect(empty.steps).toEqual([]);

    const goals: GoalNode[] = [
      { id: 'only', location: 'A', workCost: 0, prerequisiteIds: [], required: true },
    ];
    const route = planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle });
    expect(route.routeHeadId).toBe('only');
    expect(route.nextActionableGoalId).toBe('only');
  });

  it('rejects a non-integer/negative travel cost from a misbehaving oracle', () => {
    const badOracle: TravelOracle = { travelCost: () => 1.5 };
    const goals: GoalNode[] = [
      { id: 'a', location: 'A', workCost: 0, prerequisiteIds: [], required: true },
    ];
    expect(() =>
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: badOracle }),
    ).toThrow(ObjectiveRoutePlannerError);
  });

  it('rejects a non-integer work cost', () => {
    const oracle: TravelOracle = { travelCost: () => 1 };
    const goals: GoalNode[] = [
      { id: 'a', location: 'A', workCost: 1.5, prerequisiteIds: [], required: true },
    ];
    expect(() =>
      planObjectiveRoute({ goals, startLocation: 'start', travelOracle: oracle }),
    ).toThrow(ObjectiveRoutePlannerError);
  });

  it('correctly handles >=33 distinct effect tags without overflow (bigint effect masks)', () => {
    // 32 initial effects (all alphabetically before 'high-effect') saturate
    // bit indices 0-31 in the sorted effect-tag list.  'high-effect' therefore
    // lands at bit index 32.  In the old number-based implementation
    // `1 << 32 === 1` (JS 32-bit wrap), which collides with bit 0 that IS
    // already set in initialEffectMask from 'a-effect-00'.  This causes the
    // planner to consider 'high-effect' hypothetically satisfied even without
    // running the unlock goal — opening a locked edge early.  The bigint
    // implementation avoids the collision: `1n << 32n` is distinct from
    // `1n << 0n`.
    const initialEffects = new Set(
      Array.from({ length: 32 }, (_, i) => `a-effect-${String(i).padStart(2, '0')}`),
    );

    // Only the start→target edge is locked on 'high-effect'. Everything else
    // is reachable. With correct code the only finite route is
    // gate-goal(5) → reach-target(5)=10; with overflow the cheaper
    // start→target(1) appears unlocked and reach-target comes first (cost 1+5=6).
    const oracle = makeGraphOracle(
      {
        start: { 'gate-loc': 5, target: 1 },
        'gate-loc': { target: 5 },
        target: { 'gate-loc': 5 },
      },
      { start: [{ to: 'target', effect: 'high-effect' }] },
    );

    const goals: GoalNode[] = [
      {
        id: 'gate-goal',
        location: 'gate-loc',
        workCost: 0,
        prerequisiteIds: [],
        required: true,
        unlockEffects: ['high-effect'],
      },
      { id: 'reach-target', location: 'target', workCost: 0, prerequisiteIds: [], required: true },
    ];

    const route = planObjectiveRoute({
      goals,
      startLocation: 'start',
      initialSatisfiedEffects: initialEffects,
      travelOracle: oracle,
    });

    // Correct ordering: gate-goal must precede reach-target (it unlocks the
    // only low-cost path to 'target').  Overflow would reverse the order.
    expect(route.steps.map((s) => s.goalId)).toEqual(['gate-goal', 'reach-target']);
    expect(Number.isFinite(route.totalMs)).toBe(true);
    // Cost: start→gate-loc(5) + gate-loc→target(5) = 10
    expect(route.totalMs).toBe(10);
  });
});
