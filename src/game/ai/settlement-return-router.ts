/**
 * Deterministic AI safe-room/settlement return routing.
 *
 * Decides, on a per-tick basis, whether traveling back to the Floor 2
 * settlement to run the legitimate maintenance planner
 * (`settlement-maintenance-planner.ts` — claim achievements, open boss
 * chests, equip affinity-maximizing gear, shop, fill ability slots) is worth
 * the travel time/risk/opportunity cost right now, versus continuing to
 * hunt/explore. This module only ever contributes a *route target* through
 * the same real pathing pipeline every other Progress objective uses
 * (`createProgressTarget` in `bt-ai-provider.ts`) — it never teleports,
 * mutates gameplay state, grants rewards, or reads `Math.random()`/
 * `Date.now()`. All "how much is there to gain" numbers come from the real
 * `previewSettlementMaintenanceOpportunity` evaluator (which itself reuses
 * the maintenance planner's own real, already-pure scoring helpers), not a
 * guessed heuristic.
 *
 * State machine (see `getSettlementReturnIntent`/`updateSettlementReturnIntent`):
 *
 *   idle --(utility > triggerThreshold, no danger, anchor known,
 *            opportunity fingerprint changed since last service)--> armed
 *   armed --(next tick, nothing aborts/completes)--> traveling
 *   armed/traveling --(planner reports `ran:true` this frame)--> arrived
 *   arrived --> resuming --> cooldown (records lastServicedFingerprint)
 *   armed/traveling --(dangerNearby)--> aborted-danger --> cooldown
 *   armed/traveling --(progressSuppressed or anchor lost)--> aborted-unreachable --> cooldown
 *   armed/traveling --(utility recomputed < abandonThreshold)--> cooldown (defer)
 *   cooldown --(frame >= cooldownUntilFrame)--> idle
 *
 * `triggerThreshold` and `abandonThreshold` form a hysteresis band
 * (`abandonThreshold < triggerThreshold`): a utility value sitting strictly
 * between the two never re-triggers a transition either way, which is what
 * prevents oscillation. A cooldown window (duration depends on exit reason)
 * additionally bounds *timing*-based retrigger, and `lastServicedFingerprint`
 * bounds *content*-based retrigger (servicing an unchanged opportunity set
 * never re-arms even once the cooldown expires) — both are required (see
 * module-level review log in `plan.md`, concern #5).
 *
 * `dangerNearby` and `progressSuppressed` are computed by the caller (the BT
 * layer, from its own real `findNearestEnemy`/`getEngageRadius`/
 * `progressGoalSuppressedUntilFrame`) and passed in — this module never runs
 * its own combat/ECS danger query or dwell-watchdog logic, so there is
 * exactly one definition of "danger" and "unreachable" shared with every
 * sibling Progress branch (Retreat/Engage and the staircase/broker-intro
 * branches respectively).
 */
import type { GameWorld } from '../../core/world.js';
import { GAME, PLAYER_SPEED } from '../../shared/constants.js';
import {
  getLastSettlementMaintenanceResult,
  previewSettlementMaintenanceOpportunity,
  type SettlementMaintenanceOpportunityPreview,
} from './settlement-maintenance-planner.js';

export type SettlementReturnStatus =
  | 'idle'
  | 'armed'
  | 'traveling'
  | 'arrived'
  | 'resuming'
  | 'aborted-danger'
  | 'aborted-unreachable'
  | 'cooldown';

export type SettlementReturnDecisionKind =
  'trigger' | 'defer' | 'abort-danger' | 'abort-unreachable' | 'arrive' | 'maintenance' | 'resume';

export interface SettlementReturnDecision {
  readonly kind: SettlementReturnDecisionKind;
  readonly frame: number;
  readonly detail: string;
}

export interface SettlementReturnUtilityInput {
  readonly travelDistanceFt: number;
  readonly opportunity: SettlementMaintenanceOpportunityPreview;
  /**
   * Representative movement speed. Currently unused by the utility formula
   * itself (cost is priced directly per foot of travel distance, not travel
   * time — distance is a reasonable proxy for both risk and opportunity cost
   * without needing a second free parameter); retained on the input so a
   * future refinement (e.g. a genuinely time-weighted cost) doesn't need an
   * interface change, and so callers don't need two near-identical input
   * shapes depending on which cost model is active.
   */
  readonly speedFtPerMs: number;
}

export interface SettlementReturnUtilityParams {
  readonly achievementGain: number;
  readonly bossChestGain: number;
  readonly equipmentSwapGainPerScorePoint: number;
  readonly abilitySlotGain: number;
  readonly travelCostPerFoot: number;
  /** Utility must exceed this (strictly) to transition idle -> armed. */
  readonly triggerThreshold: number;
  /** Utility must fall below this (strictly) to abandon while armed/traveling. Must be < triggerThreshold (hysteresis band). */
  readonly abandonThreshold: number;
}

export interface SettlementReturnUtilityScore {
  readonly expectedGain: number;
  readonly travelCost: number;
  readonly netUtility: number;
}

export interface SettlementReturnIntent {
  readonly status: SettlementReturnStatus;
  readonly armedAtFrame: number | null;
  readonly cooldownUntilFrame: number;
  readonly lastServicedFingerprint: string;
  readonly lastUtility: SettlementReturnUtilityScore | null;
  /** Internal ring buffer of every trigger/defer/abort/arrival/maintenance/resume decision, capped at `SETTLEMENT_RETURN_DECISION_LOG_CAP`. Unit-test-visible. */
  readonly decisions: readonly SettlementReturnDecision[];
}

/**
 * Default utility weights/thresholds. Every number the formula uses is a
 * named, documented, tunable constant here — never an inline magic number.
 * Balance-tuning these values is explicitly out of scope for this slice (see
 * `plan.md`'s "config-default reasoning" — whether/how aggressively the AI
 * should return to the settlement in normal play is a game-design decision).
 */
export const DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS: SettlementReturnUtilityParams =
  Object.freeze({
    achievementGain: 40,
    bossChestGain: 60,
    equipmentSwapGainPerScorePoint: 1,
    abilitySlotGain: 25,
    travelCostPerFoot: 0.5,
    triggerThreshold: 20,
    abandonThreshold: 5,
  });

/**
 * Fallback movement-speed constant used only to populate
 * `SettlementReturnUtilityInput.speedFtPerMs` (currently inert in the
 * formula itself, see that field's doc). Mirrors the same
 * `PLAYER_SPEED / GAME.DELTA_MS` default other travel-time estimators in
 * this codebase fall back to (e.g. `bt-ai-provider.ts`'s
 * `moveSpeedFtPerMs: PLAYER_SPEED / GAME.DELTA_MS`), keeping this module
 * world/entity-independent and pure rather than needing a live per-entity
 * speed threaded through the BT integration signature.
 */
const FALLBACK_SPEED_FT_PER_MS = PLAYER_SPEED / GAME.DELTA_MS;

/** Frames to wait before re-eligibility after a completed maintenance visit. */
export const SETTLEMENT_RETURN_SERVICE_COOLDOWN_FRAMES = 600;
/** Frames to wait after a danger-triggered abort — longer than the service cooldown so the AI doesn't immediately re-arm back into the same threat. */
export const SETTLEMENT_RETURN_DANGER_COOLDOWN_FRAMES = 900;
/** Frames to wait after an unreachable-settlement abort. */
export const SETTLEMENT_RETURN_UNREACHABLE_COOLDOWN_FRAMES = 600;
/** Frames to wait after a hysteresis-band utility defer — short, since a defer (not a hard failure) may legitimately become worth it again soon. */
export const SETTLEMENT_RETURN_DEFER_COOLDOWN_FRAMES = 120;
/** Bounds the internal telemetry ring buffer so it can never grow unbounded across a long run. */
export const SETTLEMENT_RETURN_DECISION_LOG_CAP = 32;

/**
 * Pure expected-gain-vs-travel-cost utility scoring. No world/ECS access —
 * every input is a plain value the caller already computed, so this function
 * is trivially unit- and property-testable in isolation (monotonicity in
 * gain and travel distance, hysteresis band behavior).
 */
export function evaluateSettlementReturnUtility(
  input: SettlementReturnUtilityInput,
  params: SettlementReturnUtilityParams,
): SettlementReturnUtilityScore {
  const { opportunity } = input;
  const expectedGain =
    params.achievementGain * Math.max(0, opportunity.unclaimedAchievements) +
    params.bossChestGain * Math.max(0, opportunity.openBossChests) +
    params.equipmentSwapGainPerScorePoint * Math.max(0, opportunity.topEquipmentSwapScore) +
    params.abilitySlotGain * Math.max(0, opportunity.fillableAbilitySlots);
  const travelCost = params.travelCostPerFoot * Math.max(0, input.travelDistanceFt);
  return {
    expectedGain,
    travelCost,
    netUtility: expectedGain - travelCost,
  };
}

interface InternalSettlementReturnState extends SettlementReturnIntent {
  readonly enabled: boolean;
}

const routerStates = new WeakMap<GameWorld, InternalSettlementReturnState>();

function initialState(enabled: boolean): InternalSettlementReturnState {
  return {
    enabled,
    status: 'idle',
    armedAtFrame: null,
    cooldownUntilFrame: 0,
    lastServicedFingerprint: '',
    lastUtility: null,
    decisions: [],
  };
}

function pushDecision(
  state: InternalSettlementReturnState,
  frame: number,
  kind: SettlementReturnDecisionKind,
  detail: string,
): InternalSettlementReturnState {
  const decisions = [...state.decisions, { kind, frame, detail }];
  const trimmed =
    decisions.length > SETTLEMENT_RETURN_DECISION_LOG_CAP
      ? decisions.slice(decisions.length - SETTLEMENT_RETURN_DECISION_LOG_CAP)
      : decisions;
  return { ...state, decisions: trimmed };
}

export function configureSettlementReturnRouting(world: GameWorld, enabled: boolean): void {
  if (!enabled) {
    // Disabling must fully reset to idle, not just flip the flag on whatever
    // status the router happened to be in. `SettlementReturnIntent` (the
    // public shape read by `findFloor2ProgressObjective`) does not expose
    // `enabled`, so a router frozen mid-cycle (e.g. `armed`/`traveling`)
    // while disabled would otherwise keep matching the caller's status
    // guard forever, silently breaking the "disabled == byte-identical to
    // before this feature" invariant documented in `headless-runner.ts`.
    routerStates.set(world, initialState(false));
    return;
  }
  const current = routerStates.get(world);
  routerStates.set(world, current ? { ...current, enabled } : initialState(enabled));
}

/**
 * Cheap enabled check for callers that need to skip expensive per-poll
 * precompute (threat scan, engage radius, settlement anchor resolution)
 * entirely when routing is off — the default. `updateSettlementReturnIntent`
 * itself already no-ops when disabled, but by then the caller has already
 * paid for its inputs; this lets the caller avoid computing them at all.
 */
export function isSettlementReturnRoutingEnabled(world: GameWorld): boolean {
  return routerStates.get(world)?.enabled ?? false;
}

export function getSettlementReturnIntent(world: GameWorld): SettlementReturnIntent {
  return routerStates.get(world) ?? initialState(false);
}

function computeUtility(
  playerX: number,
  playerY: number,
  settlementAnchor: { x: number; y: number },
  opportunity: SettlementMaintenanceOpportunityPreview,
): SettlementReturnUtilityScore {
  const travelDistanceFt = Math.hypot(playerX - settlementAnchor.x, playerY - settlementAnchor.y);
  return evaluateSettlementReturnUtility(
    { travelDistanceFt, opportunity, speedFtPerMs: FALLBACK_SPEED_FT_PER_MS },
    DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
  );
}

/**
 * Shared per-tick evaluation for the `armed` and `traveling` statuses — the
 * plan treats them identically ("armed/traveling -> each tick, checks run in
 * this exact order"), the only distinction being that `armed` auto-promotes
 * to `traveling` once a full check has run without aborting/completing.
 *
 * REV 4 fix: arrival-consumption (step 1) is checked BEFORE any abort
 * condition (step 2), unconditionally, every tick — a completed one-shot
 * planner visit (`ran: true`) must never be silently dropped by a
 * same-frame danger/unreachable abort race, since the planner's `ran: true`
 * signal never fires again for the same continuous settlement visit.
 */
function evaluateArmedOrTravelingTick(
  world: GameWorld,
  playerEid: number,
  playerX: number,
  playerY: number,
  settlementAnchor: { x: number; y: number } | null,
  dangerNearby: boolean,
  progressSuppressed: boolean,
  state: InternalSettlementReturnState,
  frame: number,
): InternalSettlementReturnState {
  // Step 1: arrival-consumption, checked first, unconditionally.
  const lastResult = getLastSettlementMaintenanceResult(world);
  if (lastResult?.ran === true) {
    return pushDecision(
      { ...state, status: 'arrived' },
      frame,
      'arrive',
      `Arrived at the settlement; maintenance planner ran (${lastResult.decisions.length} decision(s)).`,
    );
  }

  // Step 2: abort checks, in order — only reached if step 1 did not fire.
  if (dangerNearby) {
    return pushDecision(
      { ...state, status: 'aborted-danger', armedAtFrame: null },
      frame,
      'abort-danger',
      'Danger nearby; abandoning settlement return to yield to combat.',
    );
  }
  if (progressSuppressed || settlementAnchor === null) {
    return pushDecision(
      { ...state, status: 'aborted-unreachable', armedAtFrame: null },
      frame,
      'abort-unreachable',
      'Settlement unreachable (progress suppressed or anchor unavailable); abandoning return.',
    );
  }

  const opportunity = previewSettlementMaintenanceOpportunity(world, playerEid);
  const utility = computeUtility(playerX, playerY, settlementAnchor, opportunity);
  if (utility.netUtility < DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS.abandonThreshold) {
    return pushDecision(
      {
        ...state,
        status: 'cooldown',
        armedAtFrame: null,
        cooldownUntilFrame: frame + SETTLEMENT_RETURN_DEFER_COOLDOWN_FRAMES,
        lastUtility: utility,
      },
      frame,
      'defer',
      `Utility dropped to ${utility.netUtility.toFixed(2)}, below abandon threshold; deferring return.`,
    );
  }

  return { ...state, status: 'traveling', lastUtility: utility };
}

/**
 * Called ONCE per BT poll, UNCONDITIONALLY, immediately BEFORE
 * `this.tree.tick(context)` — see `bt-ai-provider.ts`'s `decide()`. Advances
 * the state machine exactly one step every single frame regardless of which
 * BT branch fires that tick, so a danger-abort transition is always already
 * committed by the time `findFloor2ProgressObjective` (if reached this same
 * tick) does its read-only check. Never mutates gameplay state — only this
 * module's own internal per-world latch.
 */
export function updateSettlementReturnIntent(
  world: GameWorld,
  playerEid: number,
  playerX: number,
  playerY: number,
  settlementAnchor: { x: number; y: number } | null,
  dangerNearby: boolean,
  progressSuppressed: boolean,
): SettlementReturnIntent {
  let state = routerStates.get(world) ?? initialState(false);
  if (!state.enabled) {
    return state;
  }

  const frame = world.frameCount;

  switch (state.status) {
    case 'cooldown': {
      if (frame >= state.cooldownUntilFrame) {
        state = { ...state, status: 'idle', armedAtFrame: null };
      }
      break;
    }
    case 'idle': {
      if (!progressSuppressed && !dangerNearby && settlementAnchor !== null) {
        const opportunity = previewSettlementMaintenanceOpportunity(world, playerEid);
        if (opportunity.opportunityFingerprint !== state.lastServicedFingerprint) {
          const utility = computeUtility(playerX, playerY, settlementAnchor, opportunity);
          if (utility.netUtility > DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS.triggerThreshold) {
            state = pushDecision(
              { ...state, status: 'armed', armedAtFrame: frame, lastUtility: utility },
              frame,
              'trigger',
              `Settlement return armed: netUtility=${utility.netUtility.toFixed(2)} exceeds trigger threshold.`,
            );
          }
        }
      }
      break;
    }
    case 'armed':
    case 'traveling': {
      state = evaluateArmedOrTravelingTick(
        world,
        playerEid,
        playerX,
        playerY,
        settlementAnchor,
        dangerNearby,
        progressSuppressed,
        state,
        frame,
      );
      break;
    }
    case 'arrived': {
      state = pushDecision(
        { ...state, status: 'resuming' },
        frame,
        'maintenance',
        'Maintenance planner processed the visit; resuming normal AI priorities next.',
      );
      break;
    }
    case 'resuming': {
      const postVisitOpportunity = previewSettlementMaintenanceOpportunity(world, playerEid);
      state = pushDecision(
        {
          ...state,
          status: 'cooldown',
          armedAtFrame: null,
          cooldownUntilFrame: frame + SETTLEMENT_RETURN_SERVICE_COOLDOWN_FRAMES,
          lastServicedFingerprint: postVisitOpportunity.opportunityFingerprint,
          lastUtility: null,
        },
        frame,
        'resume',
        'Settlement return complete; cooling down before re-eligibility.',
      );
      break;
    }
    case 'aborted-danger': {
      state = {
        ...state,
        status: 'cooldown',
        armedAtFrame: null,
        cooldownUntilFrame: frame + SETTLEMENT_RETURN_DANGER_COOLDOWN_FRAMES,
      };
      break;
    }
    case 'aborted-unreachable': {
      state = {
        ...state,
        status: 'cooldown',
        armedAtFrame: null,
        cooldownUntilFrame: frame + SETTLEMENT_RETURN_UNREACHABLE_COOLDOWN_FRAMES,
      };
      break;
    }
  }

  routerStates.set(world, state);
  return state;
}
