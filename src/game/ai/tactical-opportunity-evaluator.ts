/**
 * Pure tactical opportunity scoring for objective travel.
 *
 * This module ranks optional value against the current critical-path leg. It does
 * not query ECS or pathfinding; callers provide reachability so walls/locked doors
 * can be rejected before straight-line detour math is used for ranking.
 */

export type TacticalOpportunityKind = 'pickup' | 'enemyPack';
export type TacticalPickupKind = 'xp' | 'gold' | 'item';

export interface TacticalOpportunityCandidate {
  readonly id: number;
  readonly kind: TacticalOpportunityKind;
  readonly pickupKind?: TacticalPickupKind;
  readonly x: number;
  readonly y: number;
  readonly value: number;
  readonly danger: number;
  readonly reachable: boolean;
  readonly debugOnly?: boolean;
}

export interface TacticalOpportunityInput {
  readonly playerX: number;
  readonly playerY: number;
  readonly objectiveX: number;
  readonly objectiveY: number;
  readonly urgency: number;
  readonly speedFtPerMs: number;
  readonly opportunities: readonly TacticalOpportunityCandidate[];
}

export interface TacticalOpportunityParams {
  readonly scanRadiusFt: number;
  readonly maxDetourFt: number;
  readonly minDetourMs: number;
  readonly urgencyPenalty: number;
  readonly dangerPenalty: number;
  readonly acceptScore: number;
  readonly maxAccepted: number;
  readonly travelWeightDivisor: number;
  readonly maxTravelWeight: number;
}

export interface ScoredTacticalOpportunity {
  readonly id: number;
  readonly kind: TacticalOpportunityKind;
  readonly pickupKind?: TacticalPickupKind;
  readonly x: number;
  readonly y: number;
  readonly value: number;
  readonly distanceFt: number;
  readonly detourFt: number;
  readonly detourMs: number;
  readonly valuePerSecond: number;
  readonly score: number;
  readonly travelWeight: number;
  readonly accepted: boolean;
  readonly reason: string;
}

export interface TacticalOpportunityEvaluation {
  readonly scored: readonly ScoredTacticalOpportunity[];
  readonly acceptedPickups: readonly ScoredTacticalOpportunity[];
}

const EPSILON = 1e-6;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function projectTacticalObjectiveLookahead(
  playerX: number,
  playerY: number,
  objDirX: number,
  objDirY: number,
  lookaheadFt: number,
): { x: number; y: number } {
  const magnitude = Math.hypot(objDirX, objDirY);
  if (magnitude <= EPSILON) {
    return { x: playerX, y: playerY };
  }
  const distanceFt = Math.max(0, lookaheadFt);
  return {
    x: playerX + (objDirX / magnitude) * distanceFt,
    y: playerY + (objDirY / magnitude) * distanceFt,
  };
}

export function scoreTacticalOpportunity(
  input: TacticalOpportunityInput,
  params: TacticalOpportunityParams,
  opportunity: TacticalOpportunityCandidate,
): ScoredTacticalOpportunity {
  const distanceFt = distance(input.playerX, input.playerY, opportunity.x, opportunity.y);
  const directObjectiveFt = distance(
    input.playerX,
    input.playerY,
    input.objectiveX,
    input.objectiveY,
  );
  const viaOpportunityFt =
    distanceFt + distance(opportunity.x, opportunity.y, input.objectiveX, input.objectiveY);
  const detourFt = Math.max(0, viaOpportunityFt - directObjectiveFt);
  const detourMs = Math.max(params.minDetourMs, detourFt / Math.max(input.speedFtPerMs, EPSILON));
  const valuePerSecond = opportunity.value / (detourMs / 1000);
  const urgencyScale = Math.max(0, 1 - clamp01(input.urgency) * params.urgencyPenalty);
  const score = valuePerSecond * urgencyScale - opportunity.danger * params.dangerPenalty;
  const travelWeight = Math.min(
    params.maxTravelWeight,
    Math.max(0, score / Math.max(params.travelWeightDivisor, EPSILON)),
  );

  let accepted = false;
  let reason = 'accepted';
  if (!opportunity.reachable) {
    reason = 'unreachable';
  } else if (distanceFt > params.scanRadiusFt) {
    reason = 'outside scan radius';
  } else if (opportunity.debugOnly || opportunity.kind !== 'pickup') {
    reason = 'debug-only';
  } else if (detourFt > params.maxDetourFt) {
    reason = 'detour too expensive';
  } else if (score < params.acceptScore) {
    reason = 'score below threshold';
  } else {
    accepted = true;
  }

  return {
    id: opportunity.id,
    kind: opportunity.kind,
    pickupKind: opportunity.pickupKind,
    x: opportunity.x,
    y: opportunity.y,
    value: opportunity.value,
    distanceFt,
    detourFt,
    detourMs,
    valuePerSecond,
    score,
    travelWeight,
    accepted,
    reason,
  };
}

export function evaluateTacticalOpportunities(
  input: TacticalOpportunityInput,
  params: TacticalOpportunityParams,
): TacticalOpportunityEvaluation {
  const scored = input.opportunities
    .map((opportunity) => scoreTacticalOpportunity(input, params, opportunity))
    .sort((a, b) => b.score - a.score || a.detourFt - b.detourFt || a.id - b.id);
  const acceptedPickups = scored
    .filter((opportunity) => opportunity.accepted)
    .slice(0, params.maxAccepted);
  return { scored, acceptedPickups };
}
