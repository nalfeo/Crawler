import { describe, expect, it } from 'vitest';
import {
  NavigationCommitmentStatus,
  advanceNavigationCommitment,
  navigationCommitmentTargetFingerprint,
  type NavigationCommitmentFacts,
  type NavigationCommitmentPolicy,
  type NavigationCommitmentState,
  type NavigationCommitmentTarget,
} from '../../../src/game/ai/navigation-commitment.js';

const target: NavigationCommitmentTarget = {
  key: 'npc:7',
  kind: 'entity',
  eid: 7,
  x: 10,
  y: 12,
  tileX: 5,
  tileY: 6,
};

const policy: NavigationCommitmentPolicy = {
  arrivalDistanceFt: 1,
  progressEpsilonFt: 0.25,
  maxOwnerNoProgressFrames: 3,
  clearWindowFrames: 2,
  arrival: 'release',
};

function facts(overrides: Partial<NavigationCommitmentFacts> = {}): NavigationCommitmentFacts {
  return {
    latched: true,
    ownsMovement: true,
    targetValid: true,
    distanceFt: 10,
    arrived: false,
    clearCondition: false,
    frame: 1,
    ...overrides,
  };
}

function activeState(): NavigationCommitmentState {
  const result = advanceNavigationCommitment({ target }, facts(), policy);
  expect(result.state).not.toBeNull();
  return result.state!;
}

describe('navigation commitment', () => {
  it('keeps target identity and tile fingerprint stable', () => {
    expect(navigationCommitmentTargetFingerprint(target)).toBe('entity:npc:7:7:5:6');
    expect(
      navigationCommitmentTargetFingerprint({
        ...target,
        x: 11,
        y: 13,
      }),
    ).toBe('entity:npc:7:7:5:6');
    expect(
      navigationCommitmentTargetFingerprint({
        ...target,
        tileY: 7,
      }),
    ).toBe('entity:npc:7:7:5:7');
  });

  it('invalidates a latched commitment when the target is not valid', () => {
    const result = advanceNavigationCommitment(
      activeState(),
      facts({ targetValid: false }),
      policy,
    );

    expect(result.status).toBe(NavigationCommitmentStatus.INVALID);
    expect(result.state).toBeNull();
    expect(result.reason).toBe('targetInvalid');
  });

  it('releases on arrival when policy says release', () => {
    const result = advanceNavigationCommitment(
      activeState(),
      facts({ distanceFt: 0.5, arrived: true, frame: 2 }),
      policy,
    );

    expect(result.status).toBe(NavigationCommitmentStatus.ARRIVED);
    expect(result.state).toBeNull();
    expect(result.reason).toBe('arrivedRelease');
  });

  it('reseeds on arrival when policy says reseed', () => {
    const result = advanceNavigationCommitment(
      activeState(),
      facts({ distanceFt: 0.5, arrived: true, frame: 2 }),
      { ...policy, arrival: 'reseed' },
    );

    expect(result.status).toBe(NavigationCommitmentStatus.RESEED);
    expect(result.state).toMatchObject({
      target,
      acquiredFrame: 2,
      bestDistanceFt: 0.5,
      ownerNoProgressFrames: 0,
      lastProgressFrame: 2,
    });
  });

  it('uses progress epsilon before resetting owner no-progress frames', () => {
    const state = activeState();
    const tinyProgress = advanceNavigationCommitment(
      state,
      facts({ distanceFt: 9.9, frame: 2 }),
      policy,
    );
    const realProgress = advanceNavigationCommitment(
      tinyProgress.state,
      facts({ distanceFt: 9.7, frame: 3 }),
      policy,
    );

    expect(tinyProgress.state?.bestDistanceFt).toBe(10);
    expect(tinyProgress.state?.ownerNoProgressFrames).toBe(1);
    expect(realProgress.state?.bestDistanceFt).toBe(9.7);
    expect(realProgress.state?.ownerNoProgressFrames).toBe(0);
    expect(realProgress.state?.lastProgressFrame).toBe(3);
  });

  it('stalls only after owner-owned no-progress frames reach policy limit', () => {
    let state: NavigationCommitmentState | null = activeState();
    for (let frame = 2; frame <= 3; frame += 1) {
      const result = advanceNavigationCommitment(state, facts({ frame }), policy);
      expect(result.status).toBe(NavigationCommitmentStatus.ACTIVE);
      state = result.state;
    }

    const stalled = advanceNavigationCommitment(state, facts({ frame: 4 }), policy);

    expect(stalled.status).toBe(NavigationCommitmentStatus.STALLED);
    expect(stalled.state).toBeNull();
  });

  it('advances clear windows independent of movement ownership', () => {
    const state = activeState();
    const firstClear = advanceNavigationCommitment(
      state,
      facts({ ownsMovement: false, clearCondition: true, frame: 2 }),
      policy,
    );
    const cleared = advanceNavigationCommitment(
      firstClear.state,
      facts({ ownsMovement: false, clearCondition: true, frame: 3 }),
      policy,
    );

    expect(firstClear.status).toBe(NavigationCommitmentStatus.ACTIVE);
    expect(firstClear.state?.clearWindowFrames).toBe(1);
    expect(firstClear.state?.ownerNoProgressFrames).toBe(0);
    expect(cleared.status).toBe(NavigationCommitmentStatus.CLEARED);
    expect(cleared.state).toBeNull();
  });

  it('freezes the motion clock across ownership loss and resumes without reset', () => {
    const state = activeState();
    const noProgress = advanceNavigationCommitment(state, facts({ frame: 2 }), policy);
    const frozen = advanceNavigationCommitment(
      noProgress.state,
      facts({ ownsMovement: false, distanceFt: 4, frame: 3 }),
      policy,
    );
    const resumed = advanceNavigationCommitment(
      frozen.state,
      facts({ distanceFt: 9.8, frame: 4 }),
      policy,
    );

    expect(noProgress.state?.ownerNoProgressFrames).toBe(1);
    expect(frozen.state?.bestDistanceFt).toBe(10);
    expect(frozen.state?.ownerNoProgressFrames).toBe(1);
    expect(resumed.state?.ownerNoProgressFrames).toBe(2);
  });

  it('does not mutate prior state objects', () => {
    const state = activeState();
    const before = structuredClone(state);

    advanceNavigationCommitment(state, facts({ distanceFt: 9, frame: 2 }), policy);

    expect(state).toEqual(before);
  });

  it('replays deterministically for the same fact stream', () => {
    const frames = [
      facts({ frame: 1 }),
      facts({ distanceFt: 9.5, frame: 2 }),
      facts({ ownsMovement: false, distanceFt: 6, frame: 3 }),
      facts({ distanceFt: 9.1, frame: 4 }),
    ];

    const replay = (): ReadonlyArray<unknown> => {
      let state: NavigationCommitmentState | null = null;
      return frames.map((frameFacts, index) => {
        const result = advanceNavigationCommitment(
          state ?? { target },
          frameFacts,
          index === frames.length - 1 ? { ...policy, maxOwnerNoProgressFrames: null } : policy,
        );
        state = result.state;
        return result;
      });
    };

    expect(replay()).toEqual(replay());
  });

  it('rejects non-finite and negative values instead of defaulting', () => {
    expect(() =>
      advanceNavigationCommitment({ target: { ...target, x: Number.NaN } }, facts(), policy),
    ).toThrow(/target.x/);
    expect(() =>
      advanceNavigationCommitment({ target }, facts({ distanceFt: Number.NaN }), policy),
    ).toThrow(/facts.distanceFt/);
    expect(() =>
      advanceNavigationCommitment({ target }, facts(), {
        ...policy,
        clearWindowFrames: 1.5,
      }),
    ).toThrow(/policy.clearWindowFrames/);
  });

  it('accepts finite negative world coordinates while keeping tile coordinates nonnegative', () => {
    expect(() =>
      advanceNavigationCommitment({ target: { ...target, x: -12, y: -3 } }, facts(), policy),
    ).not.toThrow();
    expect(() =>
      advanceNavigationCommitment({ target: { ...target, tileX: -1 } }, facts(), policy),
    ).toThrow(/target.tileX/);
  });
});
