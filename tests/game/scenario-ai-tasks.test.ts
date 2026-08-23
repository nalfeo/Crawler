import { describe, expect, it } from 'vitest';
import {
  applyScenarioWorkCosts,
  buildInteractionActionToTaskId,
  buildScenarioGoalGraph,
  resolveScenarioTaskOperation,
  validateScenarioAiTaskConfig,
  ScenarioAiTaskConfigError,
  type ScenarioAiTaskConfig,
  type ScenarioQuestLookup,
} from '../../src/game/ai/scenario-ai-tasks.js';
import {
  planObjectiveRoute,
  type TravelOracle,
} from '../../src/game/ai/objective-route-planner.js';
import type { RunPlannerPoint } from '../../src/game/ai/run-planner.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import { FLOOR1_AI_TASK_CONFIG } from '../../src/game/scenarios/floor1AiTasks.js';

/**
 * These tests exercise the GENERIC scenario-AI interpreter with synthetic
 * configs that share no code with Floor 1. Their whole point is to prove that
 * ordering, prerequisites, unlock effects, runtime eligibility, work costs, and
 * the operation vocabulary are controlled ENTIRELY by config data — the
 * interpreter is never edited between cases.
 */

interface TestSnapshot {
  readonly present: Readonly<Record<string, boolean>>;
  readonly satisfied: Readonly<Record<string, boolean>>;
  readonly costs: Readonly<Record<string, number>>;
}

interface TestParams {
  readonly unit: number;
}

const POINTS: ReadonlyMap<string, RunPlannerPoint> = new Map([
  ['home', { x: 0, y: 0 }],
  ['east', { x: 100, y: 0 }],
  ['west', { x: -100, y: 0 }],
]);

type TestConfig = ScenarioAiTaskConfig<TestSnapshot, TestParams>;

type TestTask = TestConfig['tasks'][number];

function task(overrides: Partial<TestTask> & { id: string; chainId: string }): TestTask {
  return {
    present: (s: TestSnapshot) => s.present[overrides.id] ?? true,
    satisfiedInitially: (s: TestSnapshot) => s.satisfied[overrides.id] ?? false,
    required: true,
    meta: { label: overrides.id, kind: 'work', phase: 'other' },
    detail: () => `detail:${overrides.id}`,
    workCost: (s: TestSnapshot, p: TestParams) => (s.costs[overrides.id] ?? 0) * p.unit,
    location: () => 'home',
    operation: { kind: 'ambient' },
    ...overrides,
  } as TestTask;
}

/** A valid 2-chain config: chainB anchors on chainA. */
function baseConfig(): TestConfig {
  return {
    scenarioId: 'test-scenario',
    tasks: [
      task({ id: 'a1', chainId: 'chainA', unlockEffects: ['eff-a1'], location: () => 'east' }),
      task({ id: 'a2', chainId: 'chainA', unlockEffects: ['eff-a2'] }),
      task({ id: 'b1', chainId: 'chainB', location: () => 'west' }),
      task({ id: 'b2', chainId: 'chainB' }),
    ],
    chains: [
      { id: 'chainA', taskIds: ['a1', 'a2'], anchorChainIds: [] },
      { id: 'chainB', taskIds: ['b1', 'b2'], anchorChainIds: ['chainA'] },
    ],
    locationIds: ['home', 'east', 'west'],
    npcIds: [],
    unlockEffectVocabulary: ['eff-a1', 'eff-a2'],
    buildLocations: () => POINTS,
  };
}

function snapshot(overrides: Partial<TestSnapshot> = {}): TestSnapshot {
  return { present: {}, satisfied: {}, costs: {}, ...overrides };
}

describe('scenario-ai-tasks generic interpreter — config authority', () => {
  it('derives in-chain prerequisites from config task order alone', () => {
    const graph = buildScenarioGoalGraph(baseConfig(), snapshot());
    const byId = new Map(graph.goals.map((g) => [g.id, g]));
    // Within chainA, a2 depends on a1.
    expect(byId.get('a1')?.prerequisiteIds).toEqual([]);
    expect(byId.get('a2')?.prerequisiteIds).toEqual(['a1']);
  });

  it('derives cross-chain prerequisites from anchor chain tails', () => {
    const graph = buildScenarioGoalGraph(baseConfig(), snapshot());
    const byId = new Map(graph.goals.map((g) => [g.id, g]));
    // chainB's first present task (b1) anchors on chainA's tail (a2).
    expect(byId.get('b1')?.prerequisiteIds).toEqual(['a2']);
    expect(byId.get('b2')?.prerequisiteIds).toEqual(['b1']);
  });

  it('hops the anchor tail to the last PRESENT task when a chain member is absent', () => {
    // Drop a2 via config-driven eligibility: chainA tail becomes a1.
    const graph = buildScenarioGoalGraph(baseConfig(), snapshot({ present: { a2: false } }));
    const byId = new Map(graph.goals.map((g) => [g.id, g]));
    expect(byId.has('a2')).toBe(false);
    expect(byId.get('b1')?.prerequisiteIds).toEqual(['a1']);
  });

  it('drops absent tasks from the graph entirely (runtime eligibility is config-driven)', () => {
    const graph = buildScenarioGoalGraph(
      baseConfig(),
      snapshot({ present: { a1: false, a2: false } }),
    );
    const ids = graph.goals.map((g) => g.id);
    expect(ids).toEqual(['b1', 'b2']);
    // With no present anchor task, chainB's head has no prerequisite.
    expect(graph.goals.find((g) => g.id === 'b1')?.prerequisiteIds).toEqual([]);
  });

  it('emits unlock effects onto nodes and seeds initialSatisfiedEffects independently', () => {
    const graph = buildScenarioGoalGraph(baseConfig(), snapshot({ satisfied: { a2: true } }));
    const byId = new Map(graph.goals.map((g) => [g.id, g]));
    // a1 present → its effect rides on the node.
    expect(byId.get('a1')?.unlockEffects).toEqual(['eff-a1']);
    // a2's satisfiedInitially:true seeds its effect into the initial set even
    // though its node is also still present (independent predicates).
    expect(graph.initialSatisfiedEffects).toContain('eff-a2');
  });

  it('respects the location function per task', () => {
    const graph = buildScenarioGoalGraph(baseConfig(), snapshot());
    const byId = new Map(graph.goals.map((g) => [g.id, g]));
    expect(byId.get('a1')?.location).toBe('east');
    expect(byId.get('b1')?.location).toBe('west');
    expect(byId.get('a2')?.location).toBe('home');
  });

  it('applies per-task work costs (rounded) in a separate pass', () => {
    const config = baseConfig();
    const snap = snapshot({ costs: { a1: 3, a2: 2 } });
    const graph = applyScenarioWorkCosts(config, buildScenarioGoalGraph(config, snap), snap, {
      unit: 1.5,
    });
    const byId = new Map(graph.goals.map((g) => [g.id, g]));
    expect(byId.get('a1')?.workCost).toBe(Math.round(3 * 1.5)); // 5 (rounded from 4.5)
    expect(byId.get('a2')?.workCost).toBe(3);
  });

  it('changing ONLY config data reorders the planned route with no interpreter edit', () => {
    const oracle: TravelOracle = {
      travelCost: (from, to) => {
        if (from === to) return 0;
        const p = (id: string) => POINTS.get(id) ?? { x: 0, y: 0 };
        return Math.abs(p(from).x - p(to).x) + Math.abs(p(from).y - p(to).y);
      },
    };
    const snap = snapshot();

    const original = baseConfig();
    const originalRoute = planObjectiveRoute({
      goals: buildScenarioGoalGraph(original, snap).goals,
      startLocation: 'home',
      travelOracle: oracle,
    });
    expect(originalRoute.steps.map((s) => s.goalId)).toEqual(['a1', 'a2', 'b1', 'b2']);

    // Swap the anchor direction: now chainA anchors on chainB. Pure data edit.
    const swapped: TestConfig = {
      ...original,
      chains: [
        { id: 'chainA', taskIds: ['a1', 'a2'], anchorChainIds: ['chainB'] },
        { id: 'chainB', taskIds: ['b1', 'b2'], anchorChainIds: [] },
      ],
    };
    const swappedRoute = planObjectiveRoute({
      goals: buildScenarioGoalGraph(swapped, snap).goals,
      startLocation: 'home',
      travelOracle: oracle,
    });
    expect(swappedRoute.steps.map((s) => s.goalId)).toEqual(['b1', 'b2', 'a1', 'a2']);
  });

  it('resolves a task operation by id without branching on the id', () => {
    const config: TestConfig = {
      ...baseConfig(),
      tasks: [
        task({
          id: 'a1',
          chainId: 'chainA',
          unlockEffects: ['eff-a1'],
          operation: { kind: 'move_to', location: 'east', reason: 'r', phaseTag: 'other' },
        }),
        task({ id: 'a2', chainId: 'chainA', unlockEffects: ['eff-a2'] }),
        task({
          id: 'b1',
          chainId: 'chainB',
          operation: { kind: 'farm', strategy: 'gold', label: 'grind gold' },
        }),
        task({ id: 'b2', chainId: 'chainB' }),
      ],
    };
    expect(resolveScenarioTaskOperation(config, 'a1')).toEqual({
      kind: 'move_to',
      location: 'east',
      reason: 'r',
      phaseTag: 'other',
    });
    expect(resolveScenarioTaskOperation(config, 'b1')).toEqual({
      kind: 'farm',
      strategy: 'gold',
      label: 'grind gold',
    });
    expect(resolveScenarioTaskOperation(config, 'nope')).toBeUndefined();
  });

  it('builds the interaction-action reverse map from config declarations only', () => {
    const config: TestConfig = {
      ...baseConfig(),
      tasks: [
        task({
          id: 'a1',
          chainId: 'chainA',
          unlockEffects: ['eff-a1'],
          reverseInteractionAction: 'do-a1',
        }),
        task({ id: 'a2', chainId: 'chainA', unlockEffects: ['eff-a2'] }),
        task({ id: 'b1', chainId: 'chainB', reverseInteractionAction: 'do-b1' }),
        task({ id: 'b2', chainId: 'chainB' }),
      ],
    };
    const map = buildInteractionActionToTaskId(config);
    expect(map.get('do-a1')).toBe('a1');
    expect(map.get('do-b1')).toBe('b1');
    expect(map.get('missing')).toBeUndefined();
  });
});

describe('scenario-ai-tasks generic interpreter — validation fails loudly', () => {
  function expectError(config: TestConfig, code: string, lookup?: ScenarioQuestLookup): void {
    try {
      validateScenarioAiTaskConfig(config, lookup);
      throw new Error(`expected validation to throw ${code}`);
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioAiTaskConfigError);
      expect((err as ScenarioAiTaskConfigError).code).toBe(code);
    }
  }

  it('accepts a well-formed config', () => {
    expect(() => validateScenarioAiTaskConfig(baseConfig())).not.toThrow();
  });

  it('rejects duplicate task ids', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        tasks: [...config.tasks, task({ id: 'a1', chainId: 'chainA' })],
      },
      'duplicate-task-id',
    );
  });

  it('rejects a chain that references an unknown task', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        chains: [
          { id: 'chainA', taskIds: ['a1', 'a2', 'ghost'], anchorChainIds: [] },
          { id: 'chainB', taskIds: ['b1', 'b2'], anchorChainIds: ['chainA'] },
        ],
      },
      'chain-references-unknown-task',
    );
  });

  it('rejects a task whose chainId does not list it', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        tasks: [
          task({ id: 'a1', chainId: 'chainB', unlockEffects: ['eff-a1'], location: () => 'east' }),
          task({ id: 'a2', chainId: 'chainA', unlockEffects: ['eff-a2'] }),
          task({ id: 'b1', chainId: 'chainB', location: () => 'west' }),
          task({ id: 'b2', chainId: 'chainB' }),
        ],
      },
      'task-not-in-chain',
    );
  });

  it('rejects an unknown anchor chain', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        chains: [
          { id: 'chainA', taskIds: ['a1', 'a2'], anchorChainIds: [] },
          { id: 'chainB', taskIds: ['b1', 'b2'], anchorChainIds: ['ghost'] },
        ],
      },
      'unknown-anchor-chain',
    );
  });

  it('rejects a cycle in the chain-anchor graph', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        chains: [
          { id: 'chainA', taskIds: ['a1', 'a2'], anchorChainIds: ['chainB'] },
          { id: 'chainB', taskIds: ['b1', 'b2'], anchorChainIds: ['chainA'] },
        ],
      },
      'chain-anchor-cycle',
    );
  });

  it('rejects an unsupported operation kind', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        tasks: [
          task({
            id: 'a1',
            chainId: 'chainA',
            unlockEffects: ['eff-a1'],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            operation: { kind: 'teleport' } as any,
          }),
          task({ id: 'a2', chainId: 'chainA', unlockEffects: ['eff-a2'] }),
          task({ id: 'b1', chainId: 'chainB' }),
          task({ id: 'b2', chainId: 'chainB' }),
        ],
      },
      'unsupported-operation-kind',
    );
  });

  it('rejects an operation referencing an unknown location', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        tasks: [
          task({
            id: 'a1',
            chainId: 'chainA',
            unlockEffects: ['eff-a1'],
            operation: { kind: 'engage', location: 'nowhere', reason: 'r', phaseTag: 'other' },
          }),
          task({ id: 'a2', chainId: 'chainA', unlockEffects: ['eff-a2'] }),
          task({ id: 'b1', chainId: 'chainB' }),
          task({ id: 'b2', chainId: 'chainB' }),
        ],
      },
      'unknown-location-ref',
    );
  });

  it('rejects an operation referencing an unknown NPC', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        tasks: [
          task({
            id: 'a1',
            chainId: 'chainA',
            unlockEffects: ['eff-a1'],
            operation: {
              kind: 'interact_npc',
              npc: 'ghost',
              action: 'x',
              reason: 'r',
              phaseTag: 'other',
            },
          }),
          task({ id: 'a2', chainId: 'chainA', unlockEffects: ['eff-a2'] }),
          task({ id: 'b1', chainId: 'chainB' }),
          task({ id: 'b2', chainId: 'chainB' }),
        ],
      },
      'unknown-npc-ref',
    );
  });

  it('rejects a task that emits an out-of-vocabulary unlock effect', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        tasks: [
          task({ id: 'a1', chainId: 'chainA', unlockEffects: ['eff-a1'], location: () => 'east' }),
          task({ id: 'a2', chainId: 'chainA', unlockEffects: ['not-in-vocab'] }),
          task({ id: 'b1', chainId: 'chainB', location: () => 'west' }),
          task({ id: 'b2', chainId: 'chainB' }),
        ],
      },
      'unknown-unlock-effect',
    );
  });

  it('rejects a required chain anchoring on a chain with optional tasks', () => {
    const config = baseConfig();
    expectError(
      {
        ...config,
        tasks: [
          task({
            id: 'a1',
            chainId: 'chainA',
            unlockEffects: ['eff-a1'],
            required: false,
            optionalBundleId: 'opt',
          }),
          task({
            id: 'a2',
            chainId: 'chainA',
            unlockEffects: ['eff-a2'],
            required: false,
            optionalBundleId: 'opt',
          }),
          task({ id: 'b1', chainId: 'chainB' }),
          task({ id: 'b2', chainId: 'chainB' }),
        ],
      },
      'required-depends-on-optional',
    );
  });

  it('rejects a questRef whose quest the lookup does not know', () => {
    const config = baseConfig();
    const lookup: ScenarioQuestLookup = { hasQuest: () => false, hasObjective: () => false };
    expectError(
      {
        ...config,
        tasks: [
          task({
            id: 'a1',
            chainId: 'chainA',
            unlockEffects: ['eff-a1'],
            questRef: { questId: 'ghost-quest' },
          }),
          task({ id: 'a2', chainId: 'chainA', unlockEffects: ['eff-a2'] }),
          task({ id: 'b1', chainId: 'chainB' }),
          task({ id: 'b2', chainId: 'chainB' }),
        ],
      },
      'unknown-quest-ref',
      lookup,
    );
  });

  it('rejects a questRef whose objective the lookup does not know', () => {
    const config = baseConfig();
    const lookup: ScenarioQuestLookup = {
      hasQuest: () => true,
      hasObjective: () => false,
    };
    expectError(
      {
        ...config,
        tasks: [
          task({
            id: 'a1',
            chainId: 'chainA',
            unlockEffects: ['eff-a1'],
            questRef: { questId: 'known-quest', objectiveId: 'ghost-objective' },
          }),
          task({ id: 'a2', chainId: 'chainA', unlockEffects: ['eff-a2'] }),
          task({ id: 'b1', chainId: 'chainB' }),
          task({ id: 'b2', chainId: 'chainB' }),
        ],
      },
      'unknown-objective-ref',
      lookup,
    );
  });
});

describe('Floor 1 scenario definition references its AI task overlay', () => {
  it('exposes FLOOR1_AI_TASK_CONFIG through ScenarioDefinition.aiTaskConfig', () => {
    const scenario = getScenarioDefinition('floor1');
    expect(scenario.aiTaskConfig).toBe(FLOOR1_AI_TASK_CONFIG);
  });

  it('the referenced overlay is self-consistent (validates without a lookup)', () => {
    const scenario = getScenarioDefinition('floor1');
    expect(scenario.aiTaskConfig).toBeDefined();
    expect(() => validateScenarioAiTaskConfig(scenario.aiTaskConfig!)).not.toThrow();
  });
});
