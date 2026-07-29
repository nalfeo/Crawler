/**
 * Pure Floor 1 run planner.
 *
 * The behavior tree remains the source of truth for the current objective. This
 * module only estimates how much time remains on the authoritative Floor 1 quest
 * chain so tactical layers can decide whether optional value is still affordable.
 *
 * Ordering is delegated to the declarative goal graph (`floor1-goal-graph.ts`)
 * and the generic unlock-aware planner (`objective-route-planner.ts`) — see
 * those modules for the dependency model and search algorithm. This module's
 * own responsibility is: translate live snapshot fields the graph doesn't
 * know about (safety buffer, urgency window, deadline) into the final
 * ETA/slack/urgency figure, and convert the planner's abstract route back
 * into the {@link RunPlanSegment} shape existing consumers expect.
 */

import { IN_PLACE_LOCATION, planObjectiveRoute } from './objective-route-planner.js';
import {
  applyFloor1WorkCosts,
  buildFloor1GoalGraph,
  makeStraightLineTravelOracle,
  PLAYER_START_LOCATION,
} from './floor1-goal-graph.js';

export type RunPlannerShopStage =
  | 'not-met'
  | 'awaiting-prize'
  | 'ready-to-buy'
  | 'awaiting-equip'
  | 'complete';

export interface RunPlannerPoint {
  readonly x: number;
  readonly y: number;
}

export type RunPlannerCurrentTargetKind = 'quest-kills' | 'gold-farm' | 'other';

export interface RunPlannerCurrentTarget extends RunPlannerPoint {
  readonly eid: number | null;
  readonly reason: string;
  readonly kind: RunPlannerCurrentTargetKind;
  /**
   * Explicit goal-id of the graph goal this detour fulfills, or `null` if
   * the detour is purely ad-hoc (e.g. a chase toward a drop that has no
   * corresponding graph goal). When set, the planner removes this goal from
   * the pending graph (treating it as completed via `completedGoalIds`) and
   * includes its `unlockEffects` in `initialSatisfiedEffects`, so the goal
   * is neither double-charged nor its unlock effects lost.
   */
  readonly committedGoalId?: string | null;
}

export interface Floor1RunPlannerSnapshot {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly player: RunPlannerPoint;
  readonly currentTarget: RunPlannerCurrentTarget | null;
  readonly activeQuestGiverDetour: boolean;
  readonly tutorialAccepted: boolean;
  readonly playerLevel: number;
  readonly questCompleted: boolean;
  readonly ratsKilled: number;
  readonly slimesKilled: number;
  readonly requiredRats: number;
  readonly requiredSlimes: number;
  readonly requiredTotalKills: number;
  readonly shopStage: RunPlannerShopStage;
  readonly playerGold: number;
  readonly shopkeeperEquipmentCost: number;
  readonly hasShopFetchItem: boolean;
  readonly bossBattleAccepted: boolean;
  readonly slimeRatStarted: boolean;
  readonly slimeRatDefeated: boolean;
  readonly spellsUnlocked: boolean;
  /** Explicit flag sourced from `world.goalFlags.get('floor1-boss-battle-complete') === true`.
   * Controls whether `floor1-boss-battle-complete` is in the initial satisfied effects;
   * distinct from `spellsUnlocked` which gates goal-graph construction. */
  readonly bossBattleComplete: boolean;
  readonly staircaseStarted: boolean;
  readonly staircaseDefeated: boolean;
  readonly staircaseUnlocked: boolean;
  readonly staircaseDiscovered: boolean;
  readonly merchantWeaponIntent?: {
    readonly status: 'farming' | 'returning';
    readonly cost: number;
  } | null;
  readonly positions: {
    readonly welcomeOffice: RunPlannerPoint;
    readonly shop: RunPlannerPoint;
    readonly questItem: RunPlannerPoint;
    readonly spellQuestGiver: RunPlannerPoint;
    readonly slimeRatRoom: RunPlannerPoint;
    readonly staircase: RunPlannerPoint;
  };
}

export interface RunPlannerParams {
  readonly moveSpeedFtPerMs: number;
  readonly safetyBufferMs: number;
  readonly urgencySlackWindowMs: number;
  readonly interactionMs: number;
  readonly level2GrindMs: number;
  readonly questKillMs: number;
  readonly goldFarmMs: number;
  readonly fetchPickupMs: number;
  readonly minorBossKillMs: number;
  readonly finalBossKillMs: number;
  readonly stairsInteractMs: number;
}

/**
 * Broad phase of the Floor 1 critical chain a {@link RunPlanSegment} belongs
 * to. Chain-scoped panic / prioritization consumers can filter or bucket the
 * remaining plan by phase without having to parse per-segment stable ids —
 * `id` remains available for finer-grained decisions. Phases are ordered
 * roughly along the critical path (`pre-chain → shop → spell-broker →
 * staircase → post-stairs`); `detour` is off-chain optional work that
 * chain-scoped consumers should typically exclude from chain totals. `other`
 * is reserved for future segment kinds that don't yet map to a canonical
 * phase; the current planner never emits it.
 */
export type RunPlanSegmentPhase =
  | 'detour'
  | 'pre-chain'
  | 'shop'
  | 'spell-broker'
  | 'staircase'
  | 'post-stairs'
  | 'other';

export interface RunPlanSegment {
  readonly id: string;
  readonly label: string;
  readonly kind: 'travel' | 'work' | 'boss' | 'detour';
  /**
   * Broad critical-chain phase this segment belongs to. See
   * {@link RunPlanSegmentPhase}. Data-only — behavior is unchanged; downstream
   * consumers may use it to compute chain-scoped remaining-time / slack.
   */
  readonly criticalChainPhase: RunPlanSegmentPhase;
  readonly from: RunPlannerPoint;
  readonly to: RunPlannerPoint;
  readonly travelMs: number;
  readonly workMs: number;
  readonly estimatedMs: number;
  readonly detail: string;
}

export interface Floor1RunPlan {
  readonly criticalPathObjective: string;
  readonly remainingMs: number;
  readonly estimatedRequiredMs: number;
  /**
   * Sum of {@link RunPlanSegment.travelMs} across every remaining segment. This
   * is the AI's deterministic straight-line travel-time budget between the
   * player and every remaining Floor 1 objective node — the perfect-world-
   * knowledge chain-travel figure that time-based panic/priority layers feed
   * on top of the raw deadline. Per-segment travel remains accessible on
   * {@link RunPlanSegment.travelMs} for chain-scoped consumers.
   */
  readonly estimatedTravelMs: number;
  readonly safetyBufferMs: number;
  readonly slackMs: number;
  readonly urgency: number;
  readonly segments: readonly RunPlanSegment[];
  /**
   * The unlock-aware goal-graph planner's chosen route head — the first
   * not-yet-completed goal id in the exact-optimum ordering computed by
   * `planObjectiveRoute` over the declarative Floor 1 goal graph (see
   * `floor1-goal-graph.ts`). This remains the first pending graph goal even
   * while a committed quest-giver detour is the current first leg in
   * {@link segments}; `null` only when no graph goals remain (floor clear).
   */
  readonly routeHeadId: string | null;
  /**
   * The single next goal id the agent should act on this frame. Equal to
   * {@link routeHeadId} at present — the planner has no notion of "partially
   * committed to the head goal" yet — kept as a distinct field so BT wiring
   * (`findProgressObjective`) and telemetry can evolve independently of the
   * route's own identity. See ADR discussion in the unlock-aware planner
   * review ledger for why these are separate fields.
   */
  readonly nextActionableGoalId: string | null;
  /** Optional bundles selected or rejected by the same route calculation. */
  readonly includedOptionalBundleIds: readonly string[];
  readonly droppedOptionalBundleIds: readonly string[];
}

export function canFarmOptionalMerchantPurchase(
  plan: Pick<Floor1RunPlan, 'slackMs'> | null,
  goldDeficit: number,
  goldFarmMs: number,
): boolean {
  if (!plan || goldDeficit <= 0 || goldFarmMs <= 0) {
    return false;
  }
  return plan.slackMs >= goldDeficit * goldFarmMs;
}

const EPSILON = 1e-6;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function distance(a: RunPlannerPoint, b: RunPlannerPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function travelTimeMs(
  from: RunPlannerPoint,
  to: RunPlannerPoint,
  params: RunPlannerParams,
): number {
  return distance(from, to) / Math.max(params.moveSpeedFtPerMs, EPSILON);
}

export function estimateFloor1RunPlan(
  snapshot: Floor1RunPlannerSnapshot,
  params: RunPlannerParams,
): Floor1RunPlan {
  const segments: RunPlanSegment[] = [];
  let cursor: RunPlannerPoint = snapshot.player;

  const addSegment = (
    id: string,
    label: string,
    kind: RunPlanSegment['kind'],
    phase: RunPlanSegmentPhase,
    to: RunPlannerPoint,
    workMs: number,
    detail: string,
  ): void => {
    const travelMs = travelTimeMs(cursor, to, params);
    segments.push({
      id,
      label,
      kind,
      criticalChainPhase: phase,
      from: cursor,
      to,
      travelMs,
      workMs,
      estimatedMs: travelMs + workMs,
      detail,
    });
    cursor = to;
  };

  if (snapshot.activeQuestGiverDetour && snapshot.currentTarget) {
    addSegment(
      'current-detour',
      snapshot.currentTarget.reason,
      'detour',
      'detour',
      snapshot.currentTarget,
      params.interactionMs,
      'Committed quest-giver detour before resuming the critical path',
    );
  }

  // Declarative goal graph (see floor1-goal-graph.ts): builds the set of
  // not-yet-completed Floor 1 goals with their true dependency structure
  // (shop chain and spell-broker chain are independent siblings; both must
  // finish before the staircase boss, matching the real door-lock gate), then
  // asks the generic unlock-aware planner (objective-route-planner.ts) for
  // the exact-optimum visitation order. This is the SAME route used to expose
  // `routeHeadId` / `nextActionableGoalId` below, so ETA/slack and "what goal
  // is next" always agree.
  const rawGoalGraph = buildFloor1GoalGraph(snapshot);
  const goalGraph = applyFloor1WorkCosts(rawGoalGraph, snapshot, params);
  let routeHeadId: string | null = null;
  let nextActionableGoalId: string | null = null;
  let includedOptionalBundleIds: readonly string[] = [];
  let droppedOptionalBundleIds: readonly string[] = [];

  if (goalGraph.goals.length > 0) {
    const travelOracle = makeStraightLineTravelOracle(goalGraph.locations, params.moveSpeedFtPerMs);

    // --- Committed-detour budget and goal-identity accounting ---------------
    // The planner already starts from the detour endpoint (PLAYER_START_LOCATION
    // maps to currentTarget when activeQuestGiverDetour).  Subtract the detour's
    // own travel+work cost from the budget so optional bundles that only fit
    // BEFORE the detour cost are correctly dropped.
    const detourTarget = snapshot.activeQuestGiverDetour ? snapshot.currentTarget : null;
    const detourCostMs = detourTarget
      ? travelTimeMs(snapshot.player, detourTarget, params) + params.interactionMs
      : 0;
    const rawBudgetMs = Math.max(0, snapshot.deadlineMs - snapshot.nowMs - params.safetyBufferMs);
    const planBudgetMs = Math.max(0, rawBudgetMs - detourCostMs);

    // If the detour fulfills an explicit graph goal, treat that goal as already
    // completed so it is neither replanned nor double-charged.  Its unlockEffects
    // are merged into initialSatisfiedEffects so the DP's hypothetical effect set
    // is not retroactively missing them.
    const committedGoalId = detourTarget?.committedGoalId ?? null;
    let effectiveInitialEffects = goalGraph.initialSatisfiedEffects;
    let effectiveGoals = goalGraph.goals;
    let effectiveCompletedGoalIds: ReadonlySet<string> | undefined;

    if (committedGoalId) {
      const committedGoal = goalGraph.goals.find((g) => g.id === committedGoalId);
      if (committedGoal) {
        // Remove the fulfilled goal from the pending list.
        effectiveGoals = goalGraph.goals.filter((g) => g.id !== committedGoalId);
        // Add its effects to initial satisfied effects.
        if (committedGoal.unlockEffects && committedGoal.unlockEffects.length > 0) {
          const merged = new Set(goalGraph.initialSatisfiedEffects);
          for (const eff of committedGoal.unlockEffects) merged.add(eff);
          effectiveInitialEffects = merged;
        }
        // Declare it completed so other goals may reference it as a prerequisite.
        effectiveCompletedGoalIds = new Set([committedGoalId]);
      }
    }

    const route = planObjectiveRoute({
      goals: effectiveGoals,
      startLocation: PLAYER_START_LOCATION,
      initialSatisfiedEffects: effectiveInitialEffects,
      completedGoalIds: effectiveCompletedGoalIds,
      budgetMs: planBudgetMs,
      travelOracle,
    });
    routeHeadId = route.routeHeadId;
    nextActionableGoalId = route.nextActionableGoalId;
    includedOptionalBundleIds = route.includedOptionalBundleIds;
    droppedOptionalBundleIds = route.droppedOptionalBundleIds;

    for (const step of route.steps) {
      const meta = goalGraph.meta.get(step.goalId);
      if (!meta) continue; // unreachable: every planned goal has metadata
      // Preserve the pre-existing "point Progress at the live hunted
      // entity/gold pile, not just the work-only cursor" nuance for the two
      // ambient-grind goals, exactly as the prior procedural planner did.
      let to: RunPlannerPoint;
      if (step.goalId === 'complete-goon-kills') {
        to =
          !snapshot.activeQuestGiverDetour && snapshot.currentTarget?.kind === 'quest-kills'
            ? snapshot.currentTarget
            : cursor;
      } else if (step.goalId === 'farm-shop-gold') {
        to =
          !snapshot.activeQuestGiverDetour && snapshot.currentTarget?.kind === 'gold-farm'
            ? snapshot.currentTarget
            : cursor;
      } else if (step.location === IN_PLACE_LOCATION) {
        to = cursor;
      } else {
        to = goalGraph.locations.get(step.location) ?? cursor;
      }
      addSegment(step.goalId, meta.label, meta.kind, meta.phase, to, step.workMs, meta.detail);
    }
  }

  const estimatedBeforeBuffer = segments.reduce((sum, segment) => sum + segment.estimatedMs, 0);
  const estimatedTravelMs = segments.reduce((sum, segment) => sum + segment.travelMs, 0);
  const estimatedRequiredMs = estimatedBeforeBuffer + params.safetyBufferMs;
  const remainingMs = Math.max(0, snapshot.deadlineMs - snapshot.nowMs);
  const slackMs = remainingMs - estimatedRequiredMs;
  const urgency = clamp01(1 - slackMs / Math.max(params.urgencySlackWindowMs, 1));

  return {
    criticalPathObjective: segments[0]?.label ?? 'Floor clear',
    remainingMs,
    estimatedRequiredMs,
    estimatedTravelMs,
    safetyBufferMs: params.safetyBufferMs,
    slackMs,
    urgency,
    segments,
    routeHeadId,
    nextActionableGoalId,
    includedOptionalBundleIds,
    droppedOptionalBundleIds,
  };
}
