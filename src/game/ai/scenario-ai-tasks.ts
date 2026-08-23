/**
 * Generic scenario AI task contract + interpreter.
 *
 * A scenario (e.g. Floor 1) supplies a validated {@link ScenarioAiTaskConfig}
 * overlay of declarative tasks organised into ordered {@link ScenarioAiTaskChain}s.
 * This module turns that config plus a live snapshot into the generic
 * {@link GoalNode} graph consumed by `planObjectiveRoute`
 * (`objective-route-planner.ts`) and dispatches the chosen task through a small
 * set of **generic** navigation operations.
 *
 * The whole point of this module is that it contains **no Floor-1 knowledge** —
 * no quest ids, no NPC ids, no task ids. All ordering, prerequisites, unlock
 * effects, work costs, eligibility, and per-task navigation live in the
 * scenario-owned config (see `src/game/scenarios/floor1AiTasks.ts`). The
 * interpreter only understands the generic vocabulary: chains-with-anchors,
 * per-task presence/effect predicates, and the five generic operation kinds
 * (`move_to`, `interact_npc`, `engage`, `farm`, `ambient`).
 *
 * Determinism: pure. No `Math.random()`, no `Date.now()`, no hidden state, no
 * mutation of any argument. Two runs over the same config + snapshot produce a
 * byte-identical graph.
 */

import { type GoalId, type GoalNode, type LocationId } from './objective-route-planner.js';
import type { RunPlannerPoint, RunPlanSegment, RunPlanSegmentPhase } from './run-planner.js';

// -----------------------------------------------------------------------------
// Generic operation vocabulary
// -----------------------------------------------------------------------------

/**
 * The closed set of low-level navigation operations a scenario AI task may map
 * to. Generic interpreters (`bt-ai-provider.ts`) switch on `kind` and must
 * never branch on a task id. Adding a new kind is a deliberate contract change
 * that `validateScenarioAiTaskConfig` will reject until this list is updated.
 *
 * - `move_to`    — navigate to a named location (optionally hinting an NPC eid
 *                  as the interaction anchor) with no queued interaction.
 * - `interact_npc` — navigate to a named NPC and queue an interaction action.
 * - `engage`     — navigate to a named location that hosts an encounter; the
 *                  Engage/Hunt layers take over on arrival.
 * - `farm`       — grind a named resource `strategy` until a deficit clears.
 * - `ambient`    — no navigation target of its own (handled ambiently, or an
 *                  active battle already in progress).
 */
export const SCENARIO_AI_OPERATION_KINDS = [
  'move_to',
  'interact_npc',
  'engage',
  'farm',
  'ambient',
] as const;

export type ScenarioAiOperationKind = (typeof SCENARIO_AI_OPERATION_KINDS)[number];

export type ScenarioAiOperation =
  | {
      readonly kind: 'move_to';
      readonly location: string;
      readonly reason: string;
      readonly phaseTag: string;
      /** Optional NPC key whose eid becomes the navigation anchor. */
      readonly npc?: string;
    }
  | {
      readonly kind: 'interact_npc';
      readonly npc: string;
      readonly action: string;
      readonly reason: string;
      readonly phaseTag: string;
    }
  | {
      readonly kind: 'engage';
      readonly location: string;
      readonly reason: string;
      readonly phaseTag: string;
    }
  | {
      readonly kind: 'farm';
      readonly strategy: string;
      readonly label: string;
    }
  | { readonly kind: 'ambient' };

// -----------------------------------------------------------------------------
// Task + chain + config contract
// -----------------------------------------------------------------------------

/** Presentation metadata carried alongside each generated goal node. */
export interface ScenarioGoalMeta {
  readonly label: string;
  readonly kind: RunPlanSegment['kind'];
  readonly phase: RunPlanSegmentPhase;
  readonly detail: string;
}

/** A canonical quest/objective reference this task derives from. */
export interface ScenarioQuestRef {
  readonly questId: string;
  readonly objectiveId?: string;
}

/**
 * A single declarative AI task. `S` is the scenario snapshot type; `P` is the
 * planner-params type. Every field a floor's route depends on is expressed
 * here so that ordering/eligibility/effects can change by editing config alone.
 */
export interface ScenarioAiTask<S, P> {
  /** Stable, unique id. Also the generated {@link GoalNode.id}. */
  readonly id: GoalId;
  /** Chain this task belongs to (its ordering group). */
  readonly chainId: string;
  /**
   * True when a pending {@link GoalNode} for this task should exist this frame.
   * Copied verbatim from the scenario's runtime eligibility rules; must be
   * false whenever the task is already done.
   */
  readonly present: (snapshot: S) => boolean;
  /**
   * True when this task's {@link unlockEffects} are already satisfied for the
   * snapshot (so they seed `initialSatisfiedEffects` without a pending node).
   * Independent of {@link present}: a door flag can flip before the node that
   * emits it disappears. Defaults to `false` when omitted.
   */
  readonly satisfiedInitially?: (snapshot: S) => boolean;
  /** Required tasks always appear in the route; optional ones may be dropped. */
  readonly required: boolean;
  /** Groups optional tasks into an all-or-nothing bundle. Ignored when required. */
  readonly optionalBundleId?: string;
  /** Door/feature unlock effect tags (may be negative `!tag`) this task grants. */
  readonly unlockEffects?: readonly string[];
  /** Presentation label/kind/phase. */
  readonly meta: Omit<ScenarioGoalMeta, 'detail'>;
  /** Human-readable, possibly dynamic, detail string. */
  readonly detail: (snapshot: S) => string;
  /** Non-negative integer work cost (ms) to perform this task at its location. */
  readonly workCost: (snapshot: S, params: P) => number;
  /** Location the goal node is performed at (may be the in-place sentinel). */
  readonly location: (snapshot: S) => LocationId;
  /** Generic navigation operation the BT executes for this task. */
  readonly operation: ScenarioAiOperation;
  /** Canonical quest/objective this task derives from, or null for pure
   * runtime steps (gold farming, level grind, optional purchases). */
  readonly questRef?: ScenarioQuestRef | null;
  /** Which committed NPC-interaction action maps back to this task id. */
  readonly reverseInteractionAction?: string;
}

/**
 * An ordered group of tasks. Within a chain, a present task depends on the
 * nearest present predecessor in `taskIds`; the first present task depends on
 * the concatenated pending tails of the chains named in `anchorChainIds`.
 */
export interface ScenarioAiTaskChain {
  readonly id: string;
  readonly taskIds: readonly GoalId[];
  readonly anchorChainIds: readonly string[];
}

/** A complete scenario AI task overlay. */
export interface ScenarioAiTaskConfig<S, P> {
  readonly scenarioId: string;
  /** Tasks in emission order (matches historical graph order for determinism). */
  readonly tasks: readonly ScenarioAiTask<S, P>[];
  readonly chains: readonly ScenarioAiTaskChain[];
  /** Every location id a `move_to`/`engage` operation or task location may use. */
  readonly locationIds: readonly LocationId[];
  /** Every NPC key an `interact_npc`/`move_to` operation may reference. */
  readonly npcIds: readonly string[];
  /** Closed vocabulary of unlock-effect tags any task may emit. */
  readonly unlockEffectVocabulary: readonly string[];
  /** Builds the location→point map for the snapshot (scenario geometry). */
  readonly buildLocations: (snapshot: S) => ReadonlyMap<LocationId, RunPlannerPoint>;
}

/**
 * A scenario AI task config with its snapshot/params types erased. Because `S`
 * and `P` appear only in input (contravariant) positions, every concrete
 * `ScenarioAiTaskConfig<S, P>` is assignable to this alias — so a shared
 * contract such as `ScenarioDefinition` can hold a reference to a scenario's
 * overlay without committing to that scenario's planner snapshot types.
 */
export type ErasedScenarioAiTaskConfig = ScenarioAiTaskConfig<never, never>;

// -----------------------------------------------------------------------------
// Interpreter output
// -----------------------------------------------------------------------------

export interface ScenarioGoalGraph {
  readonly goals: readonly GoalNode[];
  readonly locations: ReadonlyMap<LocationId, RunPlannerPoint>;
  readonly meta: ReadonlyMap<GoalId, ScenarioGoalMeta>;
  readonly initialSatisfiedEffects: ReadonlySet<string>;
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

export type ScenarioAiTaskConfigErrorCode =
  | 'duplicate-task-id'
  | 'duplicate-reverse-interaction-action'
  | 'task-not-in-chain'
  | 'chain-references-unknown-task'
  | 'unknown-anchor-chain'
  | 'chain-anchor-cycle'
  | 'unsupported-operation-kind'
  | 'unknown-location-ref'
  | 'unknown-npc-ref'
  | 'unknown-unlock-effect'
  | 'required-depends-on-optional'
  | 'unknown-quest-ref'
  | 'unknown-objective-ref';

export class ScenarioAiTaskConfigError extends Error {
  readonly code: ScenarioAiTaskConfigErrorCode;
  constructor(code: ScenarioAiTaskConfigErrorCode, message: string) {
    super(message);
    this.name = 'ScenarioAiTaskConfigError';
    this.code = code;
  }
}

/** Minimal quest lookup surface, injected so this module stays snapshot-agnostic. */
export interface ScenarioQuestLookup {
  hasQuest(questId: string): boolean;
  hasObjective(questId: string, objectiveId: string): boolean;
}

/**
 * Validate a scenario AI task config at load/build time. Throws
 * {@link ScenarioAiTaskConfigError} on the first structural problem so a
 * malformed overlay fails loudly rather than silently mis-routing the AI.
 */
export function validateScenarioAiTaskConfig<S, P>(
  config: ScenarioAiTaskConfig<S, P>,
  questLookup?: ScenarioQuestLookup,
): void {
  const taskById = new Map<GoalId, ScenarioAiTask<S, P>>();
  for (const task of config.tasks) {
    if (taskById.has(task.id)) {
      throw new ScenarioAiTaskConfigError(
        'duplicate-task-id',
        `Duplicate scenario AI task id "${task.id}".`,
      );
    }
    taskById.set(task.id, task);
  }

  const chainById = new Map<string, ScenarioAiTaskChain>();
  const chainIdByTask = new Map<GoalId, string>();
  for (const chain of config.chains) {
    chainById.set(chain.id, chain);
    for (const taskId of chain.taskIds) {
      if (!taskById.has(taskId)) {
        throw new ScenarioAiTaskConfigError(
          'chain-references-unknown-task',
          `Chain "${chain.id}" references unknown task "${taskId}".`,
        );
      }
      chainIdByTask.set(taskId, chain.id);
    }
  }

  // Every task must belong to exactly the chain it names.
  for (const task of config.tasks) {
    if (chainIdByTask.get(task.id) !== task.chainId) {
      throw new ScenarioAiTaskConfigError(
        'task-not-in-chain',
        `Task "${task.id}" declares chainId "${task.chainId}" but is not listed in that chain.`,
      );
    }
  }

  // Anchor references + cycle detection over the chain-anchor DAG.
  for (const chain of config.chains) {
    for (const anchorId of chain.anchorChainIds) {
      if (!chainById.has(anchorId)) {
        throw new ScenarioAiTaskConfigError(
          'unknown-anchor-chain',
          `Chain "${chain.id}" anchors on unknown chain "${anchorId}".`,
        );
      }
    }
  }
  detectChainAnchorCycle(config.chains);

  const locationIds = new Set<LocationId>(config.locationIds);
  const npcIds = new Set<string>(config.npcIds);
  const effectVocab = new Set<string>(config.unlockEffectVocabulary);
  const reverseInteractionActions = new Set<string>();

  for (const task of config.tasks) {
    if (
      task.reverseInteractionAction !== undefined &&
      reverseInteractionActions.has(task.reverseInteractionAction)
    ) {
      throw new ScenarioAiTaskConfigError(
        'duplicate-reverse-interaction-action',
        `Multiple scenario AI tasks declare reverse interaction action "${task.reverseInteractionAction}".`,
      );
    }
    if (task.reverseInteractionAction !== undefined) {
      reverseInteractionActions.add(task.reverseInteractionAction);
    }

    // Unlock effects must be in the declared vocabulary.
    for (const effect of task.unlockEffects ?? []) {
      if (!effectVocab.has(effect)) {
        throw new ScenarioAiTaskConfigError(
          'unknown-unlock-effect',
          `Task "${task.id}" emits unknown unlock effect "${effect}".`,
        );
      }
    }

    // Operation kind + operand references.
    const op = task.operation;
    if (!SCENARIO_AI_OPERATION_KINDS.includes(op.kind as ScenarioAiOperationKind)) {
      throw new ScenarioAiTaskConfigError(
        'unsupported-operation-kind',
        `Task "${task.id}" uses unsupported operation kind "${(op as { kind: string }).kind}".`,
      );
    }
    if (op.kind === 'move_to' || op.kind === 'engage') {
      if (!locationIds.has(op.location)) {
        throw new ScenarioAiTaskConfigError(
          'unknown-location-ref',
          `Task "${task.id}" operation references unknown location "${op.location}".`,
        );
      }
    }
    if (op.kind === 'interact_npc' || (op.kind === 'move_to' && op.npc !== undefined)) {
      const npc = op.kind === 'interact_npc' ? op.npc : op.npc;
      if (npc !== undefined && !npcIds.has(npc)) {
        throw new ScenarioAiTaskConfigError(
          'unknown-npc-ref',
          `Task "${task.id}" operation references unknown NPC "${npc}".`,
        );
      }
    }

    // Canonical quest/objective references, when a lookup is provided.
    if (questLookup && task.questRef) {
      if (!questLookup.hasQuest(task.questRef.questId)) {
        throw new ScenarioAiTaskConfigError(
          'unknown-quest-ref',
          `Task "${task.id}" references unknown canonical quest "${task.questRef.questId}".`,
        );
      }
      if (
        task.questRef.objectiveId !== undefined &&
        !questLookup.hasObjective(task.questRef.questId, task.questRef.objectiveId)
      ) {
        throw new ScenarioAiTaskConfigError(
          'unknown-objective-ref',
          `Task "${task.id}" references unknown objective "${task.questRef.objectiveId}" ` +
            `of quest "${task.questRef.questId}".`,
        );
      }
    }
  }

  // A required task's chain may not (transitively) anchor on a chain that
  // contains an optional task — that would make a required objective depend on
  // work the planner is free to drop.
  const chainHasRequired = new Map<string, boolean>();
  const chainHasOptional = new Map<string, boolean>();
  for (const chain of config.chains) {
    let hasRequired = false;
    let hasOptional = false;
    for (const taskId of chain.taskIds) {
      const task = taskById.get(taskId)!;
      if (task.required) hasRequired = true;
      else hasOptional = true;
    }
    chainHasRequired.set(chain.id, hasRequired);
    chainHasOptional.set(chain.id, hasOptional);
  }
  for (const chain of config.chains) {
    if (!chainHasRequired.get(chain.id)) continue;
    for (const anchorId of chain.anchorChainIds) {
      if (chainHasOptional.get(anchorId)) {
        throw new ScenarioAiTaskConfigError(
          'required-depends-on-optional',
          `Required chain "${chain.id}" anchors on chain "${anchorId}" which contains optional tasks.`,
        );
      }
    }
  }
}

function detectChainAnchorCycle(chains: readonly ScenarioAiTaskChain[]): void {
  const byId = new Map<string, ScenarioAiTaskChain>();
  for (const chain of chains) byId.set(chain.id, chain);
  const state = new Map<string, 0 | 1 | 2>(); // 0/undef=unvisited, 1=on-stack, 2=done
  const visit = (id: string): void => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) {
      throw new ScenarioAiTaskConfigError(
        'chain-anchor-cycle',
        `Cycle detected in scenario AI task chain anchors at chain "${id}".`,
      );
    }
    state.set(id, 1);
    const chain = byId.get(id);
    for (const anchorId of chain?.anchorChainIds ?? []) visit(anchorId);
    state.set(id, 2);
  };
  for (const chain of chains) visit(chain.id);
}

// -----------------------------------------------------------------------------
// Graph construction
// -----------------------------------------------------------------------------

/**
 * Turn a scenario config + snapshot into a generic goal graph. Only *present*
 * tasks become pending {@link GoalNode}s; each present task's prerequisites are
 * resolved from its chain position (nearest present predecessor, else the
 * anchor chains' pending tails). Work costs are left at `0` here — call
 * {@link applyScenarioWorkCosts} for the params-dependent second pass, mirroring
 * the historical two-phase split.
 */
export function buildScenarioGoalGraph<S, P>(
  config: ScenarioAiTaskConfig<S, P>,
  snapshot: S,
): ScenarioGoalGraph {
  const taskById = new Map<GoalId, ScenarioAiTask<S, P>>();
  for (const task of config.tasks) taskById.set(task.id, task);

  // Per-chain: the ordered list of present task ids, and the pending tail
  // (its last present task, or [] when the chain contributes nothing).
  const presentInChain = new Map<string, GoalId[]>();
  const chainTail = new Map<string, readonly GoalId[]>();
  for (const chain of config.chains) {
    const present: GoalId[] = [];
    for (const taskId of chain.taskIds) {
      const task = taskById.get(taskId);
      if (task && task.present(snapshot)) present.push(taskId);
    }
    presentInChain.set(chain.id, present);
    chainTail.set(chain.id, present.length > 0 ? [present[present.length - 1]!] : []);
  }

  const resolveAnchorPrereq = (chain: ScenarioAiTaskChain): GoalId[] => {
    const prereq: GoalId[] = [];
    for (const anchorId of chain.anchorChainIds) {
      for (const id of chainTail.get(anchorId) ?? []) prereq.push(id);
    }
    return prereq;
  };

  const chainByTask = new Map<GoalId, ScenarioAiTaskChain>();
  for (const chain of config.chains) {
    for (const taskId of chain.taskIds) chainByTask.set(taskId, chain);
  }

  const goals: GoalNode[] = [];
  const meta = new Map<GoalId, ScenarioGoalMeta>();
  const initialSatisfiedEffects = new Set<string>();

  // Seed already-satisfied unlock effects (independent of node presence).
  for (const task of config.tasks) {
    if (task.satisfiedInitially?.(snapshot)) {
      for (const effect of task.unlockEffects ?? []) initialSatisfiedEffects.add(effect);
    }
  }

  // Emit goals in config order (matches historical push order for determinism).
  for (const task of config.tasks) {
    if (!task.present(snapshot)) continue;
    const chain = chainByTask.get(task.id)!;
    const present = presentInChain.get(chain.id)!;
    const idx = present.indexOf(task.id);
    const prerequisiteIds = idx > 0 ? [present[idx - 1]!] : resolveAnchorPrereq(chain);

    const node: GoalNode = {
      id: task.id,
      location: task.location(snapshot),
      workCost: 0,
      prerequisiteIds,
      required: task.required,
      ...(task.optionalBundleId !== undefined ? { optionalBundleId: task.optionalBundleId } : {}),
      ...(task.unlockEffects !== undefined && task.unlockEffects.length > 0
        ? { unlockEffects: task.unlockEffects }
        : {}),
    };
    goals.push(node);
    meta.set(task.id, {
      label: task.meta.label,
      kind: task.meta.kind,
      phase: task.meta.phase,
      detail: task.detail(snapshot),
    });
  }

  return {
    goals,
    locations: config.buildLocations(snapshot),
    meta,
    initialSatisfiedEffects,
  };
}

/**
 * Fill each goal's `workCost` from the scenario's per-task cost functions.
 * Kept as a separate pass so the graph *shape* depends only on the snapshot
 * while durations are an explicit, easily-testable second step.
 */
export function applyScenarioWorkCosts<S, P>(
  config: ScenarioAiTaskConfig<S, P>,
  graph: ScenarioGoalGraph,
  snapshot: S,
  params: P,
): ScenarioGoalGraph {
  const taskById = new Map<GoalId, ScenarioAiTask<S, P>>();
  for (const task of config.tasks) taskById.set(task.id, task);
  const goals = graph.goals.map((goal) => {
    const task = taskById.get(goal.id);
    return {
      ...goal,
      workCost: task ? Math.round(task.workCost(snapshot, params)) : goal.workCost,
    };
  });
  return { ...graph, goals };
}

/**
 * Resolve the generic operation for a task id, or `undefined` if the config has
 * no such task. The BT dispatcher switches on the returned operation's `kind`;
 * it never branches on the id itself.
 */
export function resolveScenarioTaskOperation<S, P>(
  config: ScenarioAiTaskConfig<S, P>,
  taskId: GoalId,
): ScenarioAiOperation | undefined {
  return config.tasks.find((task) => task.id === taskId)?.operation;
}

/**
 * Build the committed-detour reverse map: NPC interaction action → stable task
 * id. Used to attribute an in-flight quest-giver detour to the graph goal it
 * fulfils so the planner neither replans nor double-charges it.
 */
export function buildInteractionActionToTaskId<S, P>(
  config: ScenarioAiTaskConfig<S, P>,
): ReadonlyMap<string, GoalId> {
  const map = new Map<string, GoalId>();
  for (const task of config.tasks) {
    if (task.reverseInteractionAction !== undefined) {
      map.set(task.reverseInteractionAction, task.id);
    }
  }
  return map;
}
