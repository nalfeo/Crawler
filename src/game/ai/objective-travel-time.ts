/**
 * Deterministic Floor 1 objective travel-time estimates.
 *
 * The headless AI has perfect knowledge of authored objective nodes. This helper
 * turns those node positions into typed travel legs. Runtime callers can supply a
 * deterministic path-distance callback (A*, navmesh, etc.); pure tests and mapless
 * callers fall back to straight-line geometry. A supplied callback returning no
 * path is never replaced by straight-line distance, because that would hide
 * unreachable-route bugs.
 */

export type Floor1ObjectiveNodeId =
  | 'player'
  | 'current-target'
  | 'welcome-office'
  | 'shopkeeper'
  | 'merchant-fetch'
  | 'spell-broker'
  | 'slime-rat-room'
  | 'staircase-boss-room'
  | 'stairs-exit';

export interface ObjectiveTravelPoint {
  readonly x: number;
  readonly y: number;
}

export interface ObjectiveTravelNode<Id extends string = Floor1ObjectiveNodeId> {
  readonly id: Id;
  readonly point: ObjectiveTravelPoint;
}

export type ObjectiveTravelSource = 'straight-line' | 'deterministic-path' | 'unreachable';

export interface ObjectiveDistanceEstimate {
  readonly distanceFt: number | null;
  readonly source?: ObjectiveTravelSource;
}

export type ObjectiveDistanceEstimator<Id extends string = Floor1ObjectiveNodeId> = (
  from: ObjectiveTravelNode<Id>,
  to: ObjectiveTravelNode<Id>,
) => number | ObjectiveDistanceEstimate | null;

export interface ObjectiveTravelParams<Id extends string = Floor1ObjectiveNodeId> {
  readonly moveSpeedFtPerMs: number;
  readonly estimateDistanceFt?: ObjectiveDistanceEstimator<Id>;
}

export interface ObjectiveTravelEstimate<Id extends string = Floor1ObjectiveNodeId> {
  readonly fromId: Id;
  readonly toId: Id;
  readonly distanceFt: number;
  readonly travelMs: number;
  readonly reachable: boolean;
  readonly source: ObjectiveTravelSource;
}

export interface ObjectiveTravelMatrix<Id extends string = Floor1ObjectiveNodeId> {
  readonly estimates: readonly ObjectiveTravelEstimate<Id>[];
  readonly byPair: Readonly<Record<string, ObjectiveTravelEstimate<Id>>>;
}

const EPSILON = 1e-6;

export function objectiveTravelPairKey(fromId: string, toId: string): string {
  return `${fromId}->${toId}`;
}

function straightLineDistance(a: ObjectiveTravelPoint, b: ObjectiveTravelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeDistanceEstimate(raw: number | ObjectiveDistanceEstimate | null): {
  distanceFt: number;
  reachable: boolean;
  source: ObjectiveTravelSource;
} {
  if (raw === null) {
    return { distanceFt: Number.POSITIVE_INFINITY, reachable: false, source: 'unreachable' };
  }
  const distanceFt = typeof raw === 'number' ? raw : raw.distanceFt;
  const source =
    typeof raw === 'number' ? 'deterministic-path' : (raw.source ?? 'deterministic-path');
  if (
    distanceFt === null ||
    !Number.isFinite(distanceFt) ||
    distanceFt < 0 ||
    source === 'unreachable'
  ) {
    return { distanceFt: Number.POSITIVE_INFINITY, reachable: false, source: 'unreachable' };
  }
  return { distanceFt, reachable: true, source };
}

export function estimateObjectiveTravelLeg<Id extends string = Floor1ObjectiveNodeId>(
  from: ObjectiveTravelNode<Id>,
  to: ObjectiveTravelNode<Id>,
  params: ObjectiveTravelParams<Id>,
): ObjectiveTravelEstimate<Id> {
  const resolved =
    from.id === to.id
      ? { distanceFt: 0, reachable: true, source: 'straight-line' as const }
      : params.estimateDistanceFt
        ? normalizeDistanceEstimate(params.estimateDistanceFt(from, to))
        : {
            distanceFt: straightLineDistance(from.point, to.point),
            reachable: true,
            source: 'straight-line' as const,
          };
  const speed = Math.max(params.moveSpeedFtPerMs, EPSILON);
  return {
    fromId: from.id,
    toId: to.id,
    distanceFt: resolved.distanceFt,
    travelMs: resolved.reachable ? resolved.distanceFt / speed : Number.POSITIVE_INFINITY,
    reachable: resolved.reachable,
    source: resolved.source,
  };
}

export function objectiveTravelMatrixFromEstimates<Id extends string = Floor1ObjectiveNodeId>(
  estimates: readonly ObjectiveTravelEstimate<Id>[],
): ObjectiveTravelMatrix<Id> {
  const byPair: Record<string, ObjectiveTravelEstimate<Id>> = Object.create(null);
  for (const estimate of estimates) {
    byPair[objectiveTravelPairKey(estimate.fromId, estimate.toId)] = estimate;
  }
  return { estimates, byPair };
}

export function estimateObjectiveTravelMatrix<Id extends string = Floor1ObjectiveNodeId>(
  nodes: readonly ObjectiveTravelNode<Id>[],
  params: ObjectiveTravelParams<Id>,
): ObjectiveTravelMatrix<Id> {
  const seen = new Set<Id>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw new Error(`Duplicate objective travel node id "${node.id}"`);
    }
    seen.add(node.id);
  }

  const estimates: ObjectiveTravelEstimate<Id>[] = [];
  for (const from of nodes) {
    for (const to of nodes) {
      estimates.push(estimateObjectiveTravelLeg(from, to, params));
    }
  }
  return objectiveTravelMatrixFromEstimates(estimates);
}

export function getObjectiveTravelEstimate<Id extends string = Floor1ObjectiveNodeId>(
  matrix: ObjectiveTravelMatrix<Id>,
  fromId: Id,
  toId: Id,
): ObjectiveTravelEstimate<Id> | null {
  return matrix.byPair[objectiveTravelPairKey(fromId, toId)] ?? null;
}
