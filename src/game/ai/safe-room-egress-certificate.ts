export interface SafeRoomEgressCertificatePolicy {
  readonly outsideMarginFrames: number;
}

export interface SafeRoomEgressCertificateObservation {
  readonly previousInsideOriginSafe: boolean;
  readonly currentInsideOriginSafe: boolean;
  readonly legalStep: boolean;
}

export interface SafeRoomEgressCertificateState {
  readonly crossedOriginBoundary: boolean;
  readonly outsideMarginFrames: number;
  readonly completed: boolean;
}

export function createSafeRoomEgressCertificateState(): SafeRoomEgressCertificateState {
  return {
    crossedOriginBoundary: false,
    outsideMarginFrames: 0,
    completed: false,
  };
}

export function advanceSafeRoomEgressCertificate(
  state: SafeRoomEgressCertificateState,
  observation: SafeRoomEgressCertificateObservation,
  policy: SafeRoomEgressCertificatePolicy,
): SafeRoomEgressCertificateState {
  validatePolicy(policy);
  if (state.completed) {
    return state;
  }

  let crossedOriginBoundary = state.crossedOriginBoundary;
  let outsideMarginFrames = state.outsideMarginFrames;

  if (observation.currentInsideOriginSafe) {
    outsideMarginFrames = 0;
  } else if (observation.legalStep) {
    if (!crossedOriginBoundary && observation.previousInsideOriginSafe) {
      crossedOriginBoundary = true;
      outsideMarginFrames = 1;
    } else if (crossedOriginBoundary) {
      outsideMarginFrames = Math.max(1, outsideMarginFrames + 1);
    } else {
      outsideMarginFrames = 0;
    }
  } else {
    outsideMarginFrames = 0;
  }

  const completed =
    crossedOriginBoundary &&
    !observation.currentInsideOriginSafe &&
    outsideMarginFrames >= policy.outsideMarginFrames;

  return {
    crossedOriginBoundary,
    outsideMarginFrames,
    completed,
  };
}

function validatePolicy(policy: SafeRoomEgressCertificatePolicy): void {
  if (!Number.isInteger(policy.outsideMarginFrames) || policy.outsideMarginFrames < 1) {
    throw new Error('policy.outsideMarginFrames must be an integer >= 1');
  }
}
