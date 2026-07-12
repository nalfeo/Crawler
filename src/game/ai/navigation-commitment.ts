export const NavigationCommitmentStatus = {
  ACTIVE: 'active',
  ARRIVED: 'arrived',
  INVALID: 'invalid',
  STALLED: 'stalled',
  CLEARED: 'cleared',
  RESEED: 'reseed',
} as const;

export type NavigationCommitmentStatusValue =
  (typeof NavigationCommitmentStatus)[keyof typeof NavigationCommitmentStatus];

export interface NavigationCommitmentTarget {
  readonly key: string;
  readonly kind: 'entity' | 'position';
  readonly eid: number | null;
  readonly x: number;
  readonly y: number;
  readonly tileX: number;
  readonly tileY: number;
}

export interface NavigationCommitmentPolicy {
  readonly arrivalDistanceFt: number;
  readonly progressEpsilonFt: number;
  readonly maxOwnerNoProgressFrames: number | null;
  readonly clearWindowFrames: number;
  readonly arrival: 'release' | 'reseed';
}

export interface NavigationCommitmentState {
  readonly target: NavigationCommitmentTarget;
  readonly acquiredFrame: number;
  readonly bestDistanceFt: number;
  readonly ownerNoProgressFrames: number;
  readonly clearWindowFrames: number;
  readonly lastProgressFrame: number;
  readonly lastReason: NavigationCommitmentAdvanceReason;
}

export interface NavigationCommitmentFacts {
  readonly latched: boolean;
  readonly ownsMovement: boolean;
  readonly targetValid: boolean;
  readonly distanceFt: number;
  readonly arrived: boolean;
  readonly clearCondition: boolean;
  readonly frame: number;
}

export interface NavigationCommitmentInitializer {
  readonly target: NavigationCommitmentTarget;
  readonly reason?: NavigationCommitmentAdvanceReason;
}

export type NavigationCommitmentInput =
  | NavigationCommitmentState
  | NavigationCommitmentInitializer
  | null;

export type NavigationCommitmentAdvanceReason =
  | 'initialized'
  | 'progress'
  | 'noProgress'
  | 'ownershipFrozen'
  | 'notLatched'
  | 'targetInvalid'
  | 'arrivedRelease'
  | 'arrivedReseed'
  | 'stalled'
  | 'clearWindowSatisfied';

export interface NavigationCommitmentAdvanceResult {
  readonly status: NavigationCommitmentStatusValue;
  readonly state: NavigationCommitmentState | null;
  readonly reason: NavigationCommitmentAdvanceReason;
}

export function navigationCommitmentTargetFingerprint(target: NavigationCommitmentTarget): string {
  validateNavigationCommitmentTarget(target);
  return [
    target.kind,
    target.key,
    target.eid === null ? 'null' : String(target.eid),
    String(target.tileX),
    String(target.tileY),
  ].join(':');
}

export function advanceNavigationCommitment(
  input: NavigationCommitmentInput,
  facts: NavigationCommitmentFacts,
  policy: NavigationCommitmentPolicy,
): NavigationCommitmentAdvanceResult {
  validateNavigationCommitmentFacts(facts);
  validateNavigationCommitmentPolicy(policy);

  if (!facts.latched) {
    return {
      status: NavigationCommitmentStatus.CLEARED,
      state: null,
      reason: 'notLatched',
    };
  }

  if (input === null) {
    throw new Error(
      'Navigation commitment requires an initializer or existing state while latched',
    );
  }

  const initialized = !isNavigationCommitmentState(input);
  const previous = normalizeInput(input, facts);
  validateNavigationCommitmentState(previous);

  if (!facts.targetValid) {
    return {
      status: NavigationCommitmentStatus.INVALID,
      state: null,
      reason: 'targetInvalid',
    };
  }

  const clearWindowFrames = facts.clearCondition ? previous.clearWindowFrames + 1 : 0;
  const cleared =
    facts.clearCondition &&
    (policy.clearWindowFrames === 0 || clearWindowFrames >= policy.clearWindowFrames);

  if (cleared) {
    return {
      status: NavigationCommitmentStatus.CLEARED,
      state: null,
      reason: 'clearWindowSatisfied',
    };
  }

  const motion = initialized
    ? {
        bestDistanceFt: previous.bestDistanceFt,
        ownerNoProgressFrames: previous.ownerNoProgressFrames,
        lastProgressFrame: previous.lastProgressFrame,
        reason: previous.lastReason,
      }
    : advanceMotionClock(previous, facts, policy);
  const arrived = facts.arrived || facts.distanceFt <= policy.arrivalDistanceFt;

  if (arrived) {
    if (policy.arrival === 'release') {
      return {
        status: NavigationCommitmentStatus.ARRIVED,
        state: null,
        reason: 'arrivedRelease',
      };
    }
    return {
      status: NavigationCommitmentStatus.RESEED,
      state: {
        target: previous.target,
        acquiredFrame: facts.frame,
        bestDistanceFt: facts.distanceFt,
        ownerNoProgressFrames: 0,
        clearWindowFrames,
        lastProgressFrame: facts.frame,
        lastReason: 'arrivedReseed',
      },
      reason: 'arrivedReseed',
    };
  }

  if (
    policy.maxOwnerNoProgressFrames !== null &&
    motion.ownerNoProgressFrames >= policy.maxOwnerNoProgressFrames
  ) {
    return {
      status: NavigationCommitmentStatus.STALLED,
      state: null,
      reason: 'stalled',
    };
  }

  return {
    status: NavigationCommitmentStatus.ACTIVE,
    state: {
      target: previous.target,
      acquiredFrame: previous.acquiredFrame,
      bestDistanceFt: motion.bestDistanceFt,
      ownerNoProgressFrames: motion.ownerNoProgressFrames,
      clearWindowFrames,
      lastProgressFrame: motion.lastProgressFrame,
      lastReason: motion.reason,
    },
    reason: motion.reason,
  };
}

function normalizeInput(
  input: NavigationCommitmentState | NavigationCommitmentInitializer,
  facts: NavigationCommitmentFacts,
): NavigationCommitmentState {
  if (isNavigationCommitmentState(input)) {
    return input;
  }
  validateNavigationCommitmentTarget(input.target);
  return {
    target: input.target,
    acquiredFrame: facts.frame,
    bestDistanceFt: facts.distanceFt,
    ownerNoProgressFrames: 0,
    clearWindowFrames: 0,
    lastProgressFrame: facts.frame,
    lastReason: input.reason ?? 'initialized',
  };
}

function isNavigationCommitmentState(
  input: NavigationCommitmentState | NavigationCommitmentInitializer,
): input is NavigationCommitmentState {
  return 'acquiredFrame' in input;
}

function advanceMotionClock(
  previous: NavigationCommitmentState,
  facts: NavigationCommitmentFacts,
  policy: NavigationCommitmentPolicy,
): Pick<
  NavigationCommitmentState,
  'bestDistanceFt' | 'ownerNoProgressFrames' | 'lastProgressFrame'
> & { readonly reason: NavigationCommitmentAdvanceReason } {
  if (!facts.ownsMovement) {
    return {
      bestDistanceFt: previous.bestDistanceFt,
      ownerNoProgressFrames: previous.ownerNoProgressFrames,
      lastProgressFrame: previous.lastProgressFrame,
      reason: 'ownershipFrozen',
    };
  }

  if (facts.distanceFt + policy.progressEpsilonFt < previous.bestDistanceFt) {
    return {
      bestDistanceFt: facts.distanceFt,
      ownerNoProgressFrames: 0,
      lastProgressFrame: facts.frame,
      reason: 'progress',
    };
  }

  return {
    bestDistanceFt: previous.bestDistanceFt,
    ownerNoProgressFrames: previous.ownerNoProgressFrames + 1,
    lastProgressFrame: previous.lastProgressFrame,
    reason: 'noProgress',
  };
}

export function validateNavigationCommitmentTarget(target: NavigationCommitmentTarget): void {
  if (target.key.length === 0) {
    throw new Error('Navigation commitment target key must be non-empty');
  }
  if (target.kind !== 'entity' && target.kind !== 'position') {
    throw new Error(`Unsupported navigation commitment target kind: ${target.kind}`);
  }
  validateNullableNonNegativeInteger(target.eid, 'target.eid');
  validateFinite(target.x, 'target.x');
  validateFinite(target.y, 'target.y');
  validateNonNegativeInteger(target.tileX, 'target.tileX');
  validateNonNegativeInteger(target.tileY, 'target.tileY');
  if (target.kind === 'entity' && target.eid === null) {
    throw new Error('Entity navigation commitment target requires an eid');
  }
  if (target.kind === 'position' && target.eid !== null) {
    throw new Error('Position navigation commitment target must use eid=null');
  }
}

export function validateNavigationCommitmentPolicy(policy: NavigationCommitmentPolicy): void {
  validateFiniteNonNegative(policy.arrivalDistanceFt, 'policy.arrivalDistanceFt');
  validateFiniteNonNegative(policy.progressEpsilonFt, 'policy.progressEpsilonFt');
  validateNullableNonNegativeInteger(
    policy.maxOwnerNoProgressFrames,
    'policy.maxOwnerNoProgressFrames',
  );
  validateNonNegativeInteger(policy.clearWindowFrames, 'policy.clearWindowFrames');
  if (policy.arrival !== 'release' && policy.arrival !== 'reseed') {
    throw new Error(`Unsupported navigation commitment arrival policy: ${policy.arrival}`);
  }
}

export function validateNavigationCommitmentState(state: NavigationCommitmentState): void {
  validateNavigationCommitmentTarget(state.target);
  validateNonNegativeInteger(state.acquiredFrame, 'state.acquiredFrame');
  validateFiniteNonNegative(state.bestDistanceFt, 'state.bestDistanceFt');
  validateNonNegativeInteger(state.ownerNoProgressFrames, 'state.ownerNoProgressFrames');
  validateNonNegativeInteger(state.clearWindowFrames, 'state.clearWindowFrames');
  validateNonNegativeInteger(state.lastProgressFrame, 'state.lastProgressFrame');
}

export function validateNavigationCommitmentFacts(facts: NavigationCommitmentFacts): void {
  validateFiniteNonNegative(facts.distanceFt, 'facts.distanceFt');
  validateNonNegativeInteger(facts.frame, 'facts.frame');
}

function validateFiniteNonNegative(value: number, label: string): void {
  validateFinite(value, label);
  if (value < 0) {
    throw new Error(`${label} must be finite and nonnegative`);
  }
}

function validateFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
}

function validateNonNegativeInteger(value: number, label: string): void {
  validateFiniteNonNegative(value, label);
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
}

function validateNullableNonNegativeInteger(value: number | null, label: string): void {
  if (value === null) return;
  validateNonNegativeInteger(value, label);
}
