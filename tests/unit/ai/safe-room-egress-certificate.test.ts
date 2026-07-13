import { describe, expect, it } from 'vitest';
import {
  advanceSafeRoomEgressCertificate,
  createSafeRoomEgressCertificateState,
  type SafeRoomEgressCertificateObservation,
} from '../../../src/game/ai/safe-room-egress-certificate.js';

const policy = { outsideMarginFrames: 2 };

function step(
  state = createSafeRoomEgressCertificateState(),
  observation: SafeRoomEgressCertificateObservation,
) {
  return advanceSafeRoomEgressCertificate(state, observation, policy);
}

describe('safe-room egress certificate', () => {
  it('mouth flicker re-entry before margin does not complete', () => {
    const crossed = step(undefined, {
      previousInsideOriginSafe: true,
      currentInsideOriginSafe: false,
      legalStep: true,
    });
    const reentered = step(crossed, {
      previousInsideOriginSafe: false,
      currentInsideOriginSafe: true,
      legalStep: true,
    });
    const recrossed = step(reentered, {
      previousInsideOriginSafe: true,
      currentInsideOriginSafe: false,
      legalStep: true,
    });

    expect(crossed.completed).toBe(false);
    expect(reentered.completed).toBe(false);
    expect(recrossed.completed).toBe(false);
    expect(recrossed.outsideMarginFrames).toBe(1);
  });

  it('completes after a legal boundary cross and outside margin', () => {
    const crossed = step(undefined, {
      previousInsideOriginSafe: true,
      currentInsideOriginSafe: false,
      legalStep: true,
    });
    const completed = step(crossed, {
      previousInsideOriginSafe: false,
      currentInsideOriginSafe: false,
      legalStep: true,
    });

    expect(completed.completed).toBe(true);
    expect(completed.outsideMarginFrames).toBe(2);
  });

  it('boundary hugging with re-entry does not complete', () => {
    const crossed = step(undefined, {
      previousInsideOriginSafe: true,
      currentInsideOriginSafe: false,
      legalStep: true,
    });
    const reentered = step(crossed, {
      previousInsideOriginSafe: false,
      currentInsideOriginSafe: true,
      legalStep: true,
    });

    expect(reentered.completed).toBe(false);
    expect(reentered.outsideMarginFrames).toBe(0);
  });

  it('rejects non-adjacent or blocked through-wall movement as certification evidence', () => {
    const illegalCross = step(undefined, {
      previousInsideOriginSafe: true,
      currentInsideOriginSafe: false,
      legalStep: false,
    });
    const outside = step(illegalCross, {
      previousInsideOriginSafe: false,
      currentInsideOriginSafe: false,
      legalStep: true,
    });

    expect(illegalCross.crossedOriginBoundary).toBe(false);
    expect(outside.completed).toBe(false);
  });

  it('treats post-completion re-entry as a new episode', () => {
    const completed = step(
      step(undefined, {
        previousInsideOriginSafe: true,
        currentInsideOriginSafe: false,
        legalStep: true,
      }),
      {
        previousInsideOriginSafe: false,
        currentInsideOriginSafe: false,
        legalStep: true,
      },
    );

    const stayedCompleted = step(completed, {
      previousInsideOriginSafe: false,
      currentInsideOriginSafe: true,
      legalStep: true,
    });
    const newEpisodeCross = step(createSafeRoomEgressCertificateState(), {
      previousInsideOriginSafe: true,
      currentInsideOriginSafe: false,
      legalStep: true,
    });

    expect(completed.completed).toBe(true);
    expect(stayedCompleted.completed).toBe(true);
    expect(newEpisodeCross.completed).toBe(false);
    expect(newEpisodeCross.crossedOriginBoundary).toBe(true);
  });
});
