import {
  advanceNavigationCommitment,
  navigationCommitmentTargetFingerprint,
  type NavigationCommitmentAdvanceResult,
  type NavigationCommitmentFacts,
  type NavigationCommitmentPolicy,
  type NavigationCommitmentState,
  type NavigationCommitmentTarget,
} from './navigation-commitment.js';

export const MovementIntentOwner = {
  RETREAT: 'retreat',
  ARENA_LOCKIN: 'arenaLockin',
  INTERACTION_IMMEDIATE: 'interactionImmediate',
  INTERACTION_APPROACH: 'interactionApproach',
  SAFE_ROOM_EGRESS: 'safeRoomEgress',
  PROGRESSION: 'progression',
} as const;

export type MovementIntentOwnerValue =
  (typeof MovementIntentOwner)[keyof typeof MovementIntentOwner];

export const MOVEMENT_INTENT_ACQUISITION_PRIORITIES = {
  [MovementIntentOwner.RETREAT]: 600,
  [MovementIntentOwner.ARENA_LOCKIN]: 500,
  [MovementIntentOwner.INTERACTION_IMMEDIATE]: 400,
  [MovementIntentOwner.INTERACTION_APPROACH]: 350,
  [MovementIntentOwner.SAFE_ROOM_EGRESS]: 300,
  [MovementIntentOwner.PROGRESSION]: 200,
} as const satisfies Record<MovementIntentOwnerValue, number>;

export type MovementIntentZone = 'any' | 'insideSafe' | 'outsideSafe';
export type MovementIntentTargetRelation = 'any' | 'sameSafeSpace' | 'outsideCurrentSafeSpace';

export interface MovementIntentEligibilityFacts {
  readonly zone: MovementIntentZone;
  readonly targetRelation: MovementIntentTargetRelation;
  readonly domainAvailable: boolean;
  readonly physicalLock?: boolean;
}

export interface MovementIntentTarget extends NavigationCommitmentTarget {
  readonly valid: boolean;
}

export interface MovementIntentCommitment {
  readonly policy: NavigationCommitmentPolicy;
  readonly facts: NavigationCommitmentFacts;
  readonly reference?: string;
}

export interface MovementIntentExecution<TPayload = undefined> {
  readonly token: string;
  readonly payload: TPayload;
  readonly reason: string;
}

export interface MovementIntentProposal<TPayload = undefined> {
  readonly owner: MovementIntentOwnerValue;
  readonly key: string;
  readonly declarationOrdinal: number;
  readonly priority?: number;
  readonly eligibility: MovementIntentEligibilityFacts;
  readonly target: MovementIntentTarget;
  readonly commitment: MovementIntentCommitment;
  readonly execution: MovementIntentExecution<TPayload>;
}

export interface MovementIntentLease {
  readonly owner: MovementIntentOwnerValue;
  readonly key: string;
  readonly priority: number;
  readonly declarationOrdinal: number;
  readonly target: NavigationCommitmentTarget;
  readonly targetFingerprint: string;
  readonly executionToken: string;
  readonly reason: string;
}

export interface MovementIntentArbiterState {
  readonly current: MovementIntentLease | null;
  readonly navigation: NavigationCommitmentState | null;
}

export interface MovementIntentArbiterFacts {
  readonly playerZone: Exclude<MovementIntentZone, 'any'>;
}

export type MovementIntentTransition =
  | 'acquired'
  | 'retained'
  | 'preempted'
  | 'released'
  | 'rejected';

export type MovementIntentResolutionReason =
  | 'acquiredBestEligible'
  | 'acquiredAfterMissingRetainedLease'
  | 'acquiredAfterCommitmentRelease'
  | 'retainedLease'
  | 'preemptedByAllowedPair'
  | 'releasedNoRetainedProposal'
  | 'releasedByCommitment'
  | 'rejectedNoEligibleProposals';

export interface MovementIntentResolution<TPayload = undefined> {
  readonly selected: MovementIntentProposal<TPayload> | null;
  readonly nextState: MovementIntentArbiterState;
  readonly transition: MovementIntentTransition;
  readonly reason: MovementIntentResolutionReason;
  readonly priorOwner: MovementIntentOwnerValue | null;
  readonly priorKey: string | null;
  readonly commitment: NavigationCommitmentAdvanceResult | null;
  readonly proposalCount: number;
  readonly eligibleProposalCount: number;
  readonly proposalDigest: string;
  readonly eligibleProposalDigest: string;
}

export interface MovementIntentTelemetry {
  /** Active movement owner this frame, or null for legacy fallback/no movement. */
  readonly owner: MovementIntentOwnerValue | null;
  readonly key: string | null;
  readonly transition: MovementIntentTransition;
  readonly reason: MovementIntentResolutionReason;
  readonly priorOwner: MovementIntentOwnerValue | null;
  readonly priorKey: string | null;
  readonly commitmentStatus: NavigationCommitmentAdvanceResult['status'] | null;
  readonly commitmentReason: NavigationCommitmentAdvanceResult['reason'] | null;
  readonly executionToken: string | null;
  readonly proposalCount: number;
  readonly eligibleProposalCount: number;
  readonly proposalDigest: string;
  readonly eligibleProposalDigest: string;
}

interface RankedProposal<TPayload> {
  readonly proposal: MovementIntentProposal<TPayload>;
  readonly priority: number;
  readonly targetFingerprint: string;
}

export function movementIntentTargetFingerprint(target: MovementIntentTarget): string {
  return navigationCommitmentTargetFingerprint(target);
}

export function resolveMovementIntent<TPayload = undefined>(
  state: MovementIntentArbiterState,
  proposals: ReadonlyArray<MovementIntentProposal<TPayload>>,
  facts: MovementIntentArbiterFacts,
): MovementIntentResolution<TPayload> {
  validateArbiterState(state);
  validateArbiterFacts(facts);

  const ranked = proposals.map((proposal) => rankProposal(proposal));
  const eligible = ranked.filter((candidate) => isProposalEligible(candidate.proposal, facts));
  const meta = buildResolutionMeta(ranked, eligible);

  const current = state.current;
  if (current === null) {
    return acquireFromCandidates(
      eligible,
      null,
      null,
      'acquired',
      'acquiredBestEligible',
      'rejectedNoEligibleProposals',
      null,
      meta,
    );
  }

  const retained = eligible.find((candidate) => leaseMatchesProposal(current, candidate));
  if (retained === undefined) {
    return acquireFromCandidates(
      eligible,
      current.owner,
      current.key,
      'acquired',
      'acquiredAfterMissingRetainedLease',
      'releasedNoRetainedProposal',
      null,
      meta,
    );
  }

  const retainedCommitment = advanceNavigationCommitment(
    state.navigation ?? { target: retained.proposal.target, reason: 'initialized' },
    retained.proposal.commitment.facts,
    retained.proposal.commitment.policy,
  );

  if (retainedCommitment.state === null) {
    const challengersAfterRelease = eligible.filter((ranked) => ranked !== retained);
    return acquireFromCandidates(
      challengersAfterRelease,
      current.owner,
      current.key,
      'acquired',
      'acquiredAfterCommitmentRelease',
      'releasedByCommitment',
      retainedCommitment,
      meta,
    );
  }

  const allowedChallengers = eligible.filter(
    (ranked) => ranked !== retained && canPreemptMovementIntent(current, ranked.proposal, facts),
  );
  const challenger = chooseBest(allowedChallengers);
  if (challenger !== null) {
    const preempted = tryAcquireCandidate(
      challenger,
      current.owner,
      current.key,
      'preempted',
      'preemptedByAllowedPair',
      meta,
    );
    if (preempted !== null) {
      return preempted;
    }
  }

  return {
    selected: retained.proposal,
    nextState: {
      current: leaseFromProposal(retained),
      navigation: retainedCommitment.state,
    },
    transition: 'retained',
    reason: 'retainedLease',
    priorOwner: current.owner,
    priorKey: current.key,
    commitment: retainedCommitment,
    ...meta,
  };
}

export function movementIntentTelemetry<TPayload>(
  resolution: MovementIntentResolution<TPayload>,
): MovementIntentTelemetry {
  return {
    owner: resolution.selected?.owner ?? null,
    key: resolution.selected?.key ?? null,
    transition: resolution.transition,
    reason: resolution.reason,
    priorOwner: resolution.priorOwner,
    priorKey: resolution.priorKey,
    commitmentStatus: resolution.commitment?.status ?? null,
    commitmentReason: resolution.commitment?.reason ?? null,
    executionToken: resolution.selected?.execution.token ?? null,
    proposalCount: resolution.proposalCount,
    eligibleProposalCount: resolution.eligibleProposalCount,
    proposalDigest: resolution.proposalDigest,
    eligibleProposalDigest: resolution.eligibleProposalDigest,
  };
}

export function canPreemptMovementIntent<TPayload>(
  current: Pick<MovementIntentLease, 'owner'>,
  challenger: MovementIntentProposal<TPayload>,
  facts: MovementIntentArbiterFacts,
): boolean {
  validateArbiterFacts(facts);
  validateProposal(challenger);

  if (current.owner === MovementIntentOwner.SAFE_ROOM_EGRESS) {
    if (challenger.owner === MovementIntentOwner.INTERACTION_IMMEDIATE) {
      return facts.playerZone === 'insideSafe';
    }
    if (challenger.owner === MovementIntentOwner.ARENA_LOCKIN) {
      return facts.playerZone === 'outsideSafe' && challenger.eligibility.physicalLock === true;
    }
    return false;
  }

  if (current.owner === MovementIntentOwner.ARENA_LOCKIN) {
    return challenger.owner === MovementIntentOwner.RETREAT && facts.playerZone === 'outsideSafe';
  }

  return explicitPreemptionPairs[current.owner].includes(challenger.owner);
}

const explicitPreemptionPairs: Record<
  MovementIntentOwnerValue,
  ReadonlyArray<MovementIntentOwnerValue>
> = {
  [MovementIntentOwner.RETREAT]: [],
  [MovementIntentOwner.ARENA_LOCKIN]: [],
  [MovementIntentOwner.INTERACTION_IMMEDIATE]: [
    MovementIntentOwner.RETREAT,
    MovementIntentOwner.ARENA_LOCKIN,
  ],
  [MovementIntentOwner.INTERACTION_APPROACH]: [
    MovementIntentOwner.RETREAT,
    MovementIntentOwner.ARENA_LOCKIN,
    MovementIntentOwner.INTERACTION_IMMEDIATE,
  ],
  [MovementIntentOwner.SAFE_ROOM_EGRESS]: [],
  [MovementIntentOwner.PROGRESSION]: [
    MovementIntentOwner.RETREAT,
    MovementIntentOwner.ARENA_LOCKIN,
    MovementIntentOwner.INTERACTION_IMMEDIATE,
    MovementIntentOwner.INTERACTION_APPROACH,
    MovementIntentOwner.SAFE_ROOM_EGRESS,
  ],
};

function rejected<TPayload>(
  state: MovementIntentArbiterState,
  reason: Extract<MovementIntentResolutionReason, 'rejectedNoEligibleProposals'>,
  priorOwner: MovementIntentOwnerValue | null,
  priorKey: string | null,
  meta: ResolutionMeta,
): MovementIntentResolution<TPayload> {
  return {
    selected: null,
    nextState: state,
    transition: 'rejected',
    reason,
    priorOwner,
    priorKey,
    commitment: null,
    ...meta,
  };
}

function emptyState(): MovementIntentArbiterState {
  return {
    current: null,
    navigation: null,
  };
}

function chooseBest<TPayload>(
  proposals: ReadonlyArray<RankedProposal<TPayload>>,
): RankedProposal<TPayload> | null {
  let best: RankedProposal<TPayload> | null = null;
  for (const proposal of proposals) {
    if (best === null || compareRankedProposal(proposal, best) < 0) {
      best = proposal;
    }
  }
  return best;
}

function compareRankedProposal<TPayload>(
  left: RankedProposal<TPayload>,
  right: RankedProposal<TPayload>,
): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.proposal.declarationOrdinal !== right.proposal.declarationOrdinal) {
    return left.proposal.declarationOrdinal - right.proposal.declarationOrdinal;
  }
  const ownerKey = `${left.proposal.owner}:${left.proposal.key}`;
  const otherOwnerKey = `${right.proposal.owner}:${right.proposal.key}`;
  if (ownerKey !== otherOwnerKey) return compareCodeUnits(ownerKey, otherOwnerKey);
  return compareCodeUnits(targetTieKey(left.proposal.target), targetTieKey(right.proposal.target));
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function leaseFromProposal<TPayload>(ranked: RankedProposal<TPayload>): MovementIntentLease {
  return {
    owner: ranked.proposal.owner,
    key: ranked.proposal.key,
    priority: ranked.priority,
    declarationOrdinal: ranked.proposal.declarationOrdinal,
    target: ranked.proposal.target,
    targetFingerprint: ranked.targetFingerprint,
    executionToken: ranked.proposal.execution.token,
    reason: ranked.proposal.execution.reason,
  };
}

function leaseMatchesProposal<TPayload>(
  lease: MovementIntentLease,
  ranked: RankedProposal<TPayload>,
): boolean {
  return (
    lease.owner === ranked.proposal.owner &&
    lease.key === ranked.proposal.key &&
    lease.targetFingerprint === ranked.targetFingerprint
  );
}

function targetTieKey(target: MovementIntentTarget): string {
  const eid = target.eid === null ? Number.MAX_SAFE_INTEGER : target.eid;
  return [
    target.kind,
    String(eid).padStart(12, '0'),
    String(target.tileX).padStart(12, '0'),
    String(target.tileY).padStart(12, '0'),
    target.key,
  ].join(':');
}

function rankProposal<TPayload>(
  proposal: MovementIntentProposal<TPayload>,
): RankedProposal<TPayload> {
  validateProposal(proposal);
  return {
    proposal,
    priority: proposal.priority ?? MOVEMENT_INTENT_ACQUISITION_PRIORITIES[proposal.owner],
    targetFingerprint: movementIntentTargetFingerprint(proposal.target),
  };
}

interface ResolutionMeta {
  readonly proposalCount: number;
  readonly eligibleProposalCount: number;
  readonly proposalDigest: string;
  readonly eligibleProposalDigest: string;
}

function buildResolutionMeta<TPayload>(
  ranked: ReadonlyArray<RankedProposal<TPayload>>,
  eligible: ReadonlyArray<RankedProposal<TPayload>>,
): ResolutionMeta {
  return {
    proposalCount: ranked.length,
    eligibleProposalCount: eligible.length,
    proposalDigest: digestRankedProposals(ranked),
    eligibleProposalDigest: digestRankedProposals(eligible),
  };
}

function digestRankedProposals<TPayload>(ranked: ReadonlyArray<RankedProposal<TPayload>>): string {
  if (ranked.length === 0) return 'none';
  const keys = ranked
    .map((candidate) =>
      [
        String(candidate.priority),
        String(candidate.proposal.declarationOrdinal),
        candidate.proposal.owner,
        candidate.proposal.key,
        candidate.targetFingerprint,
        candidate.proposal.eligibility.zone,
        candidate.proposal.eligibility.targetRelation,
        candidate.proposal.eligibility.domainAvailable ? '1' : '0',
        candidate.proposal.eligibility.physicalLock === true ? '1' : '0',
      ].join(':'),
    )
    .sort(compareCodeUnits);
  let hash = 0x811c9dc5;
  for (const key of keys) {
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 124;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function acquireFromCandidates<TPayload>(
  candidates: ReadonlyArray<RankedProposal<TPayload>>,
  priorOwner: MovementIntentOwnerValue | null,
  priorKey: string | null,
  transition: Extract<MovementIntentTransition, 'acquired' | 'preempted'>,
  acquisitionReason: Extract<
    MovementIntentResolutionReason,
    'acquiredBestEligible' | 'acquiredAfterMissingRetainedLease' | 'acquiredAfterCommitmentRelease'
  >,
  fallbackReason: Extract<
    MovementIntentResolutionReason,
    'rejectedNoEligibleProposals' | 'releasedNoRetainedProposal' | 'releasedByCommitment'
  >,
  fallbackCommitment: NavigationCommitmentAdvanceResult | null,
  meta: ResolutionMeta,
): MovementIntentResolution<TPayload> {
  const sorted = [...candidates].sort(compareRankedProposal);
  let latestReleaseCommitment: NavigationCommitmentAdvanceResult | null = fallbackCommitment;
  for (const candidate of sorted) {
    const acquired = tryAcquireCandidate(
      candidate,
      priorOwner,
      priorKey,
      transition,
      acquisitionReason,
      meta,
    );
    if (acquired !== null) {
      return acquired;
    }
    latestReleaseCommitment = advanceNavigationCommitment(
      { target: candidate.proposal.target, reason: 'initialized' },
      candidate.proposal.commitment.facts,
      candidate.proposal.commitment.policy,
    );
  }

  if (fallbackReason === 'rejectedNoEligibleProposals') {
    return rejected(
      { current: null, navigation: null },
      'rejectedNoEligibleProposals',
      priorOwner,
      priorKey,
      meta,
    );
  }
  return {
    selected: null,
    nextState: emptyState(),
    transition: 'released',
    reason: fallbackReason,
    priorOwner,
    priorKey,
    commitment: latestReleaseCommitment,
    ...meta,
  };
}

function tryAcquireCandidate<TPayload>(
  ranked: RankedProposal<TPayload>,
  priorOwner: MovementIntentOwnerValue | null,
  priorKey: string | null,
  transition: Extract<MovementIntentTransition, 'acquired' | 'preempted'>,
  reason: MovementIntentResolutionReason,
  meta: ResolutionMeta,
): MovementIntentResolution<TPayload> | null {
  const commitment = advanceNavigationCommitment(
    { target: ranked.proposal.target, reason: 'initialized' },
    ranked.proposal.commitment.facts,
    ranked.proposal.commitment.policy,
  );
  if (commitment.state === null) {
    return null;
  }
  return {
    selected: ranked.proposal,
    nextState: {
      current: leaseFromProposal(ranked),
      navigation: commitment.state,
    },
    transition,
    reason,
    priorOwner,
    priorKey,
    commitment,
    ...meta,
  };
}

function isProposalEligible<TPayload>(
  proposal: MovementIntentProposal<TPayload>,
  facts: MovementIntentArbiterFacts,
): boolean {
  if (!proposal.eligibility.domainAvailable) return false;
  if (proposal.eligibility.zone !== 'any' && proposal.eligibility.zone !== facts.playerZone) {
    return false;
  }
  return proposal.target.valid;
}

function validateProposal<TPayload>(proposal: MovementIntentProposal<TPayload>): void {
  if (!isMovementIntentOwner(proposal.owner)) {
    throw new Error(`Unsupported movement intent owner: ${proposal.owner}`);
  }
  if (proposal.key.length === 0) {
    throw new Error('Movement intent key must be non-empty');
  }
  validateNonNegativeInteger(proposal.declarationOrdinal, 'proposal.declarationOrdinal');
  if (proposal.priority !== undefined) {
    validateFiniteNonNegative(proposal.priority, 'proposal.priority');
  }
  validateEligibility(proposal.eligibility);
  validateTarget(proposal.target);
  if (proposal.execution.token.length === 0) {
    throw new Error('Movement intent execution token must be non-empty');
  }
  if (proposal.execution.reason.length === 0) {
    throw new Error('Movement intent execution reason must be non-empty');
  }
}

function validateEligibility(eligibility: MovementIntentEligibilityFacts): void {
  if (
    eligibility.zone !== 'any' &&
    eligibility.zone !== 'insideSafe' &&
    eligibility.zone !== 'outsideSafe'
  ) {
    throw new Error(`Unsupported movement intent zone: ${eligibility.zone}`);
  }
  if (
    eligibility.targetRelation !== 'any' &&
    eligibility.targetRelation !== 'sameSafeSpace' &&
    eligibility.targetRelation !== 'outsideCurrentSafeSpace'
  ) {
    throw new Error(`Unsupported movement intent target relation: ${eligibility.targetRelation}`);
  }
}

function validateTarget(target: MovementIntentTarget): void {
  movementIntentTargetFingerprint(target);
}

function validateArbiterState(state: MovementIntentArbiterState): void {
  if (state.current === null && state.navigation !== null) {
    throw new Error('Movement intent navigation state requires a current lease');
  }
  if (state.current !== null && state.navigation === null) {
    throw new Error('Movement intent lease requires navigation state');
  }
}

function validateArbiterFacts(facts: MovementIntentArbiterFacts): void {
  if (facts.playerZone !== 'insideSafe' && facts.playerZone !== 'outsideSafe') {
    throw new Error(`Unsupported movement intent player zone: ${facts.playerZone}`);
  }
}

function isMovementIntentOwner(owner: string): owner is MovementIntentOwnerValue {
  return Object.values(MovementIntentOwner).includes(owner as MovementIntentOwnerValue);
}

function validateFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and nonnegative`);
  }
}

function validateNonNegativeInteger(value: number, label: string): void {
  validateFiniteNonNegative(value, label);
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
}
