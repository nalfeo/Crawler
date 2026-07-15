/**
 * Generic unlock-aware objective-route planner.
 *
 * A small, pure, deterministic constrained planner over a goal graph: given a
 * set of {@link GoalNode}s (each with a stable id, a location, an integer work
 * cost, prerequisite ids, a required/optional flag, and door-unlock "effect"
 * tags it satisfies once completed) plus a strict {@link TravelOracle}, this
 * module computes the exact-optimum route: visit every required goal, and as
 * many optional goal *bundles* as fit a time budget, minimizing total
 * travel+work time, with fully deterministic tie-breaks.
 *
 * This module has NO game-specific knowledge (no Floor 1 quest ids, no NPC
 * ids, no world/ECS imports) — Floor-specific goal graphs are built by
 * separate modules (e.g. `floor1-goal-graph.ts`) that translate live game
 * state into {@link GoalNode}s and hand them to {@link planObjectiveRoute}.
 *
 * Design notes (see docs/knowledge/review-ledgers for the reviewed plan):
 * - The search state is `(completedGoalMask, currentLocation)`. The satisfied
 *   *effect* mask is not a separate dimension — it is a pure function of the
 *   completed-goal mask (`initialSatisfiedEffects ∪ union(unlockEffects of
 *   goals in mask)`), so tracking it as a derived value keeps the state space
 *   small without losing information.
 * - `currentLocation` — not "last goal index" — is the second DP dimension.
 *   Two different goals that happen to share a location are equivalent for
 *   every future transition, so keying by location (rather than by which
 *   specific goal was last) merges those states for a smaller, still-exact
 *   search space. A dedicated {@link IN_PLACE_LOCATION} sentinel models
 *   "work-only" goals (e.g. XP grinding, kill-quota grinding) that cost zero
 *   travel and do not change the current location — see the doc comment on
 *   the constant.
 * - The travel oracle is STRICT: unreachable must be `Infinity`, never a
 *   Euclidean/heuristic guess. A required goal that is unreachable from every
 *   possible predecessor throws {@link ObjectiveRoutePlannerError} (code
 *   `'unreachable-required-goal'`) rather than silently returning an
 *   `Infinity`-cost "success". An unreachable OPTIONAL goal is not an error —
 *   its bundle is simply never selected because any mask containing it has
 *   `Infinity` cost, which can never satisfy a finite budget and never wins a
 *   min-cost comparison against a strictly smaller finite-cost mask.
 * - Optional goals are grouped into bundles via {@link GoalNode.optionalBundleId}
 *   (an optional goal without one is its own singleton bundle). Bundles are
 *   all-or-nothing: the final route either includes every goal in a bundle or
 *   none of them. "Maximize optional value" means maximize the *count of
 *   included bundles*, not the count of raw optional goal steps.
 * - Every DP memo replacement and every final-candidate selection breaks ties
 *   using strictly-ascending stable goal-id lexicographic order — never
 *   iteration/insertion order — so the result is deterministic regardless of
 *   how the caller orders the `goals` array.
 * - This is an exact Held-Karp-style bitmask DP/branch-and-bound, not a
 *   heuristic — it is only safe for small graphs. {@link MAX_GOAL_NODES}
 *   bounds the pending-goal count; a larger graph throws rather than
 *   silently degrading to an approximate answer.
 *
 * Pure: no `Math.random()`, no `Date.now()`, no hidden state, no mutation of
 * any argument.
 */

export type GoalId = string;
export type LocationId = string;

/**
 * Sentinel location for "work-only" goals that happen wherever the agent
 * currently stands (XP grinding, kill-quota grinding, equipping a purchased
 * item, etc.) — zero travel cost to reach, and completing one does not change
 * the agent's current location for the purposes of the next transition.
 */
export const IN_PLACE_LOCATION: LocationId = '__in_place__';

export interface GoalNode {
  /** Stable, unique identifier. Also used for every deterministic tie-break. */
  readonly id: GoalId;
  /** Where the agent must stand to perform this goal's work. Use
   * {@link IN_PLACE_LOCATION} for goals with no fixed travel destination. */
  readonly location: LocationId;
  /** Non-negative integer cost (ms) to perform the goal once at its location. */
  readonly workCost: number;
  /** Ids of goals (or already-completed ids passed via
   * {@link PlanObjectiveRouteInput.completedGoalIds}) that must be satisfied
   * before this goal becomes eligible. */
  readonly prerequisiteIds: readonly GoalId[];
  /** Required goals must always appear in the returned route. */
  readonly required: boolean;
  /** Groups optional goals into an all-or-nothing unit. Optional goals
   * without one default to a singleton bundle keyed by their own id. Ignored
   * for required goals. */
  readonly optionalBundleId?: string;
  /** Door/feature-unlock tags this goal satisfies once completed. Consulted
   * by the travel oracle via the "satisfied effects" argument. */
  readonly unlockEffects?: readonly string[];
}

/**
 * Strict travel-cost oracle. MUST return `Infinity` for an unreachable pair —
 * never a Euclidean/heuristic distance estimate standing in for "I don't
 * know". `satisfiedEffects` is the set of unlock-effect tags active at the
 * moment travel begins (i.e. from every goal already completed earlier in
 * the hypothetical route, unioned with the planner's initial effects) — doors
 * gated on an effect tag should be treated as open once that tag is present.
 * Must return a non-negative integer, or `Infinity`. Must be pure/deterministic:
 * identical arguments always produce the identical result.
 */
export interface TravelOracle {
  travelCost(from: LocationId, to: LocationId, satisfiedEffects: ReadonlySet<string>): number;
}

export type ObjectiveRoutePlannerErrorCode =
  | 'duplicate-goal-id'
  | 'unknown-prerequisite'
  | 'cycle'
  | 'node-cardinality-exceeded'
  | 'invalid-work-cost'
  | 'invalid-travel-cost'
  | 'unreachable-required-goal';

export class ObjectiveRoutePlannerError extends Error {
  readonly code: ObjectiveRoutePlannerErrorCode;
  constructor(code: ObjectiveRoutePlannerErrorCode, message: string) {
    super(message);
    this.name = 'ObjectiveRoutePlannerError';
    this.code = code;
  }
}

/** Safety cap on pending (not-yet-completed) goal count. The DP is exact and
 * exponential (`O(2^n * distinctLocations * n)`); this bounds worst-case work
 * to a graph size appropriate for a single floor's objective chain rather
 * than silently degrading to an approximate answer for a larger graph. */
export const MAX_GOAL_NODES = 18;

export interface PlanObjectiveRouteInput {
  /** Only NOT-yet-completed goals. Already-completed goals should simply be
   * omitted — list their ids in {@link completedGoalIds} instead so other
   * goals may reference them as a prerequisite. */
  readonly goals: readonly GoalNode[];
  readonly startLocation: LocationId;
  /** Ids already completed prior to this plan (not re-visited, but usable as
   * a prerequisite reference). */
  readonly completedGoalIds?: ReadonlySet<GoalId>;
  /** Unlock-effect tags already satisfied before any goal in this plan runs
   * (e.g. doors unlocked by past actions outside this graph). */
  readonly initialSatisfiedEffects?: ReadonlySet<string>;
  /** Total time budget in ms. `undefined`/`Infinity` means unlimited — every
   * reachable optional bundle is affordable. */
  readonly budgetMs?: number;
  readonly travelOracle: TravelOracle;
}

export interface RouteStep {
  readonly goalId: GoalId;
  readonly location: LocationId;
  readonly travelMs: number;
  readonly workMs: number;
}

export interface ObjectiveRoute {
  readonly steps: readonly RouteStep[];
  readonly totalTravelMs: number;
  readonly totalWorkMs: number;
  readonly totalMs: number;
  readonly includedOptionalBundleIds: readonly string[];
  readonly droppedOptionalBundleIds: readonly string[];
  /** True only when even the minimum-time required-only route exceeds
   * `budgetMs`. The returned route is still the minimal required route in
   * that case — required goals are never dropped to fit a budget. */
  readonly requiredOverBudget: boolean;
  /** First step's goal id, or `null` for an empty route (nothing left to do). */
  readonly routeHeadId: GoalId | null;
  /** The single next goal the agent should act on. Equal to `routeHeadId` at
   * this generic layer (there is no "in-flight" concept here) — kept as a
   * distinct field because floor-specific wiring layers may want to report a
   * stable route identity separately from "what to do this frame". */
  readonly nextActionableGoalId: GoalId | null;
}

function assertNonNegativeInteger(
  value: number,
  code: ObjectiveRoutePlannerErrorCode,
  what: string,
): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ObjectiveRoutePlannerError(
      code,
      `${what} must be a non-negative integer, got ${value}.`,
    );
  }
}

function assertValidTravelCost(value: number): void {
  if (value === Infinity) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ObjectiveRoutePlannerError(
      'invalid-travel-cost',
      `Travel oracle must return a non-negative integer or Infinity, got ${value}.`,
    );
  }
}

/** Lexicographic compare of two goal-id path arrays. Shorter-is-not-implied:
 * only called on paths of equal length (equal mask popcount) in this module. */
function comparePathsLex(a: readonly GoalId[], b: readonly GoalId[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return a[i]! < b[i]! ? -1 : 1;
    }
  }
  return a.length - b.length;
}

interface DpEntry {
  readonly cost: number;
  readonly path: readonly GoalId[];
}

/** Replace `current` with `candidate` when candidate is strictly cheaper, or
 * tied and lexicographically smaller. Central chokepoint so every memo
 * replacement in this module uses the same deterministic rule. */
function isBetterEntry(candidate: DpEntry, current: DpEntry | undefined): boolean {
  if (!current) return true;
  if (candidate.cost !== current.cost) return candidate.cost < current.cost;
  return comparePathsLex(candidate.path, current.path) < 0;
}

export function planObjectiveRoute(input: PlanObjectiveRouteInput): ObjectiveRoute {
  const { travelOracle, startLocation } = input;
  const completedGoalIds = input.completedGoalIds ?? new Set<GoalId>();
  const initialEffects = input.initialSatisfiedEffects ?? new Set<string>();
  const budgetMs = input.budgetMs ?? Infinity;

  // --- Validation -----------------------------------------------------
  const goals = [...input.goals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (goals.length > MAX_GOAL_NODES) {
    throw new ObjectiveRoutePlannerError(
      'node-cardinality-exceeded',
      `Objective route planner received ${goals.length} pending goals, exceeding the cap of ${MAX_GOAL_NODES}.`,
    );
  }

  const idToIndex = new Map<GoalId, number>();
  for (const goal of goals) {
    if (idToIndex.has(goal.id)) {
      throw new ObjectiveRoutePlannerError('duplicate-goal-id', `Duplicate goal id "${goal.id}".`);
    }
    idToIndex.set(goal.id, idToIndex.size);
  }

  for (const goal of goals) {
    assertNonNegativeInteger(goal.workCost, 'invalid-work-cost', `Goal "${goal.id}" workCost`);
    for (const prereqId of goal.prerequisiteIds) {
      if (!idToIndex.has(prereqId) && !completedGoalIds.has(prereqId)) {
        throw new ObjectiveRoutePlannerError(
          'unknown-prerequisite',
          `Goal "${goal.id}" references unknown prerequisite "${prereqId}".`,
        );
      }
    }
  }

  const n = goals.length;
  // Bitmask of in-graph prerequisites per goal (prereqs satisfied by
  // completedGoalIds are trivially true and excluded from the mask).
  const prereqMask: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let mask = 0;
    for (const prereqId of goals[i]!.prerequisiteIds) {
      const idx = idToIndex.get(prereqId);
      if (idx !== undefined) {
        mask |= 1 << idx;
      }
    }
    prereqMask[i] = mask;
  }

  // Cycle detection (DFS, 3-color) over the in-graph prerequisite edges.
  {
    const color = new Array<0 | 1 | 2>(n).fill(0);
    const visit = (i: number): void => {
      if (color[i] === 2) return;
      if (color[i] === 1) {
        throw new ObjectiveRoutePlannerError(
          'cycle',
          `Cyclic prerequisite dependency detected at goal "${goals[i]!.id}".`,
        );
      }
      color[i] = 1;
      let mask = prereqMask[i]!;
      while (mask !== 0) {
        const bit = mask & -mask;
        const j = Math.log2(bit) | 0;
        visit(j);
        mask &= mask - 1;
      }
      color[i] = 2;
    };
    for (let i = 0; i < n; i++) visit(i);
  }

  // Effect-tag bit assignment (stable ascending order).
  // Effect masks use bigint so that graphs with more than 31 distinct effect
  // tags do not overflow JS 32-bit bitwise integers.  Completed-goal masks
  // remain plain number because MAX_GOAL_NODES=18 keeps them safely within
  // 32 bits.
  const effectTagSet = new Set<string>();
  for (const tag of initialEffects) effectTagSet.add(tag);
  for (const goal of goals) {
    for (const tag of goal.unlockEffects ?? []) effectTagSet.add(tag);
  }
  const effectTags = [...effectTagSet].sort();
  const effectBitIndex = new Map<string, number>(effectTags.map((tag, i) => [tag, i]));
  const goalEffectMask: bigint[] = new Array(n).fill(0n);
  for (let i = 0; i < n; i++) {
    let mask = 0n;
    for (const tag of goals[i]!.unlockEffects ?? []) {
      const bit = effectBitIndex.get(tag);
      if (bit !== undefined) mask |= 1n << BigInt(bit);
    }
    goalEffectMask[i] = mask;
  }
  let initialEffectMask = 0n;
  for (const tag of initialEffects) {
    const bit = effectBitIndex.get(tag);
    if (bit !== undefined) initialEffectMask |= 1n << BigInt(bit);
  }
  const effectSetCache = new Map<bigint, ReadonlySet<string>>();
  const effectsAtMask = (mask: number): ReadonlySet<string> => {
    let bits = initialEffectMask;
    let m = mask;
    while (m !== 0) {
      const bit = m & -m;
      const idx = Math.log2(bit) | 0;
      bits |= goalEffectMask[idx]!;
      m &= m - 1;
    }
    const cached = effectSetCache.get(bits);
    if (cached) return cached;
    const set = new Set<string>();
    for (const tag of effectTags) {
      const tagBit = effectBitIndex.get(tag);
      if (tagBit !== undefined && (bits & (1n << BigInt(tagBit))) !== 0n) set.add(tag);
    }
    effectSetCache.set(bits, set);
    return set;
  };

  const resolveTravelCost = (from: LocationId, to: LocationId, mask: number): number => {
    if (to === IN_PLACE_LOCATION) return 0;
    const cost = travelOracle.travelCost(from, to, effectsAtMask(mask));
    assertValidTravelCost(cost);
    return cost;
  };

  // --- DP: state = (completed-goal mask, current location) ------------
  const totalMasks = 1 << n;
  const dp: Array<Map<LocationId, DpEntry>> = new Array(totalMasks);
  dp[0] = new Map([[startLocation, { cost: 0, path: [] }]]);

  for (let mask = 0; mask < totalMasks; mask++) {
    const atMask = dp[mask];
    if (!atMask) continue;
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0) continue; // already completed
      if ((prereqMask[i]! & mask) !== prereqMask[i]!) continue; // prereqs unmet
      const goal = goals[i]!;
      const newMask = mask | (1 << i);
      let target = dp[newMask];
      if (!target) {
        target = new Map<LocationId, DpEntry>();
        dp[newMask] = target;
      }
      for (const [loc, entry] of atMask) {
        const travelMs = resolveTravelCost(loc, goal.location, mask);
        const newCost = entry.cost + travelMs + goal.workCost;
        if (newCost === Infinity) continue; // never worth memoizing an unreachable step
        const newLoc = goal.location === IN_PLACE_LOCATION ? loc : goal.location;
        const candidate: DpEntry = { cost: newCost, path: [...entry.path, goal.id] };
        const current = target.get(newLoc);
        if (isBetterEntry(candidate, current)) {
          target.set(newLoc, candidate);
        }
      }
    }
  }

  const bestForMask = (mask: number): DpEntry | null => {
    const atMask = dp[mask];
    if (!atMask || atMask.size === 0) return null;
    let best: DpEntry | null = null;
    for (const entry of atMask.values()) {
      if (isBetterEntry(entry, best ?? undefined)) best = entry;
    }
    return best;
  };

  // --- Required / optional bundle bookkeeping --------------------------
  let requiredMask = 0;
  const bundleOf: Array<string | null> = new Array(n).fill(null);
  const bundleMembers = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (goals[i]!.required) {
      requiredMask |= 1 << i;
    } else {
      const bundleId = goals[i]!.optionalBundleId ?? goals[i]!.id;
      bundleOf[i] = bundleId;
      const members = bundleMembers.get(bundleId) ?? [];
      members.push(i);
      bundleMembers.set(bundleId, members);
    }
  }
  const bundleIds = [...bundleMembers.keys()].sort();
  const bundleMaskOf = new Map<string, number>();
  for (const [bundleId, members] of bundleMembers) {
    let mask = 0;
    for (const idx of members) mask |= 1 << idx;
    bundleMaskOf.set(bundleId, mask);
  }

  const requiredOnly = bestForMask(requiredMask);
  if (!requiredOnly || !Number.isFinite(requiredOnly.cost)) {
    throw new ObjectiveRoutePlannerError(
      'unreachable-required-goal',
      'No feasible route exists that reaches every required goal from the start location; ' +
        'a required goal is unreachable given the current effect/unlock state.',
    );
  }

  const isValidFinalMask = (mask: number): boolean => {
    if ((mask & requiredMask) !== requiredMask) return false;
    for (const [, bundleMask] of bundleMaskOf) {
      const overlap = mask & bundleMask;
      if (overlap !== 0 && overlap !== bundleMask) return false;
    }
    return true;
  };

  const countBundles = (mask: number): number => {
    let count = 0;
    for (const bundleMask of bundleMaskOf.values()) {
      if ((mask & bundleMask) === bundleMask && bundleMask !== 0) count++;
    }
    return count;
  };

  const requiredOverBudget = requiredOnly.cost > budgetMs;

  let chosenMask = requiredMask;
  let chosenEntry = requiredOnly;

  if (!requiredOverBudget) {
    let bestBundleCount = -1;
    for (let mask = 0; mask < totalMasks; mask++) {
      if (!isValidFinalMask(mask)) continue;
      const entry = bestForMask(mask);
      if (!entry || !Number.isFinite(entry.cost)) continue;
      if (entry.cost > budgetMs) continue;
      const bundleCount = countBundles(mask);
      if (bundleCount < bestBundleCount) continue;
      if (bundleCount > bestBundleCount) {
        bestBundleCount = bundleCount;
        chosenMask = mask;
        chosenEntry = entry;
        continue;
      }
      // Tie on bundle count: minimize cost, then lexicographic path.
      if (
        entry.cost < chosenEntry.cost ||
        (entry.cost === chosenEntry.cost && comparePathsLex(entry.path, chosenEntry.path) < 0)
      ) {
        chosenMask = mask;
        chosenEntry = entry;
      }
    }
  }

  const includedOptionalBundleIds = bundleIds.filter(
    (id) =>
      (chosenMask & (bundleMaskOf.get(id) ?? 0)) === (bundleMaskOf.get(id) ?? 0) &&
      (bundleMaskOf.get(id) ?? 0) !== 0,
  );
  const droppedOptionalBundleIds = bundleIds.filter(
    (id) => !includedOptionalBundleIds.includes(id),
  );

  // --- Replay the chosen path to build step-by-step travel/work costs --
  const steps: RouteStep[] = [];
  let curLoc = startLocation;
  let curMask = 0;
  let totalTravelMs = 0;
  let totalWorkMs = 0;
  for (const goalId of chosenEntry.path) {
    const idx = idToIndex.get(goalId)!;
    const goal = goals[idx]!;
    const travelMs = resolveTravelCost(curLoc, goal.location, curMask);
    steps.push({ goalId, location: goal.location, travelMs, workMs: goal.workCost });
    totalTravelMs += travelMs;
    totalWorkMs += goal.workCost;
    curMask |= 1 << idx;
    if (goal.location !== IN_PLACE_LOCATION) curLoc = goal.location;
  }

  const routeHeadId = steps[0]?.goalId ?? null;

  return {
    steps,
    totalTravelMs,
    totalWorkMs,
    totalMs: totalTravelMs + totalWorkMs,
    includedOptionalBundleIds,
    droppedOptionalBundleIds,
    requiredOverBudget,
    routeHeadId,
    nextActionableGoalId: routeHeadId,
  };
}
