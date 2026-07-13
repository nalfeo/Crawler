import { describe, expect, it } from 'vitest';
import {
  MOVEMENT_INTENT_ACQUISITION_PRIORITIES,
  MovementIntentOwner,
  canPreemptMovementIntent,
  movementIntentTelemetry,
  resolveMovementIntent,
  type MovementIntentArbiterFacts,
  type MovementIntentArbiterState,
  type MovementIntentOwnerValue,
  type MovementIntentProposal,
  type MovementIntentTarget,
} from '../../../src/game/ai/movement-intent-arbiter.js';
import type { NavigationCommitmentPolicy } from '../../../src/game/ai/navigation-commitment.js';

const owners = [
  MovementIntentOwner.RETREAT,
  MovementIntentOwner.ARENA_LOCKIN,
  MovementIntentOwner.INTERACTION_IMMEDIATE,
  MovementIntentOwner.INTERACTION_APPROACH,
  MovementIntentOwner.SAFE_ROOM_EGRESS,
  MovementIntentOwner.PROGRESSION,
] as const;

const policy: NavigationCommitmentPolicy = {
  arrivalDistanceFt: 1,
  progressEpsilonFt: 0.25,
  maxOwnerNoProgressFrames: 3,
  clearWindowFrames: 2,
  arrival: 'release',
};

const outsideSafe: MovementIntentArbiterFacts = { playerZone: 'outsideSafe' };
const insideSafe: MovementIntentArbiterFacts = { playerZone: 'insideSafe' };

function targetFor(owner: MovementIntentOwnerValue, tile = owner.length): MovementIntentTarget {
  const eid = owner === MovementIntentOwner.PROGRESSION ? null : tile;
  return {
    key: `${owner}:target`,
    kind: eid === null ? 'position' : 'entity',
    eid,
    x: tile + 1,
    y: tile + 2,
    tileX: tile,
    tileY: tile + 1,
    valid: true,
  };
}

function proposal(
  owner: MovementIntentOwnerValue,
  overrides: Partial<MovementIntentProposal<string>> = {},
): MovementIntentProposal<string> {
  const target = overrides.target ?? targetFor(owner);
  return {
    owner,
    key: overrides.key ?? `${owner}:lease`,
    declarationOrdinal: overrides.declarationOrdinal ?? owners.indexOf(owner),
    priority: overrides.priority,
    eligibility: overrides.eligibility ?? {
      zone: 'any',
      targetRelation: 'any',
      domainAvailable: true,
      physicalLock: owner === MovementIntentOwner.ARENA_LOCKIN,
    },
    target,
    commitment: overrides.commitment ?? {
      policy,
      facts: {
        latched: true,
        ownsMovement: true,
        targetValid: target.valid,
        distanceFt: 10,
        arrived: false,
        clearCondition: false,
        frame: 1,
      },
    },
    execution: overrides.execution ?? {
      token: `${owner}:execute`,
      payload: `${owner}:payload`,
      reason: `${owner}:reason`,
    },
  };
}

function acquireState(
  current: MovementIntentProposal<string>,
  facts: MovementIntentArbiterFacts = outsideSafe,
): MovementIntentArbiterState {
  const result = resolveMovementIntent({ current: null, navigation: null }, [current], facts);
  expect(result.selected).toBe(current);
  expect(result.nextState.current).not.toBeNull();
  expect(result.nextState.navigation).not.toBeNull();
  return result.nextState;
}

function permute<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i]!;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permute(rest)) {
      out.push([head, ...tail]);
    }
  }
  return out;
}

function expectedPreemption(
  current: MovementIntentOwnerValue,
  challenger: MovementIntentOwnerValue,
  facts: MovementIntentArbiterFacts,
): boolean {
  if (current === MovementIntentOwner.SAFE_ROOM_EGRESS) {
    if (challenger === MovementIntentOwner.INTERACTION_IMMEDIATE) {
      return facts.playerZone === 'insideSafe';
    }
    if (challenger === MovementIntentOwner.ARENA_LOCKIN) {
      return facts.playerZone === 'outsideSafe';
    }
    return false;
  }
  if (current === MovementIntentOwner.ARENA_LOCKIN) {
    return challenger === MovementIntentOwner.RETREAT && facts.playerZone === 'outsideSafe';
  }
  if (current === MovementIntentOwner.INTERACTION_IMMEDIATE) {
    return (
      challenger === MovementIntentOwner.RETREAT || challenger === MovementIntentOwner.ARENA_LOCKIN
    );
  }
  if (current === MovementIntentOwner.INTERACTION_APPROACH) {
    return (
      challenger === MovementIntentOwner.RETREAT ||
      challenger === MovementIntentOwner.ARENA_LOCKIN ||
      challenger === MovementIntentOwner.INTERACTION_IMMEDIATE
    );
  }
  if (current === MovementIntentOwner.PROGRESSION) {
    return challenger !== MovementIntentOwner.PROGRESSION;
  }
  return false;
}

describe('movement intent arbiter', () => {
  it('exports centralized acquisition priorities', () => {
    expect(MOVEMENT_INTENT_ACQUISITION_PRIORITIES).toEqual({
      retreat: 600,
      arenaLockin: 500,
      interactionImmediate: 400,
      interactionApproach: 350,
      safeRoomEgress: 300,
      progression: 200,
    });
  });

  it('enforces singular lease ownership invariants', () => {
    expect(() =>
      resolveMovementIntent(
        {
          current: null,
          navigation: {
            target: targetFor(MovementIntentOwner.RETREAT),
            acquiredFrame: 1,
            bestDistanceFt: 1,
            ownerNoProgressFrames: 0,
            clearWindowFrames: 0,
            lastProgressFrame: 1,
            lastReason: 'initialized',
          },
        },
        [],
        outsideSafe,
      ),
    ).toThrow(/requires a current lease/);

    expect(() =>
      resolveMovementIntent(
        {
          current: {
            owner: MovementIntentOwner.RETREAT,
            key: 'retreat',
            priority: 600,
            declarationOrdinal: 0,
            target: targetFor(MovementIntentOwner.RETREAT),
            targetFingerprint: 'entity:retreat:1:1:2',
            executionToken: 'retreat',
            reason: 'retreat',
          },
          navigation: null,
        },
        [proposal(MovementIntentOwner.RETREAT)],
        outsideSafe,
      ),
    ).toThrow(/requires navigation state/);
  });

  it('is permutation-invariant under synthetic equal-priority ties', () => {
    const tieSet = [
      proposal(MovementIntentOwner.INTERACTION_APPROACH, {
        key: 'b',
        priority: 777,
        declarationOrdinal: 1,
        target: targetFor(MovementIntentOwner.INTERACTION_APPROACH, 8),
      }),
      proposal(MovementIntentOwner.ARENA_LOCKIN, {
        key: 'alpha',
        priority: 777,
        declarationOrdinal: 1,
        target: targetFor(MovementIntentOwner.ARENA_LOCKIN, 9),
        eligibility: {
          zone: 'any',
          targetRelation: 'any',
          domainAvailable: true,
          physicalLock: true,
        },
      }),
      proposal(MovementIntentOwner.INTERACTION_IMMEDIATE, {
        key: 'z',
        priority: 777,
        declarationOrdinal: 1,
        target: targetFor(MovementIntentOwner.INTERACTION_IMMEDIATE, 10),
      }),
    ];

    const winners = permute(tieSet).map((ordered) => {
      const result = resolveMovementIntent(
        { current: null, navigation: null },
        ordered,
        outsideSafe,
      );
      return {
        owner: result.selected?.owner ?? null,
        key: result.selected?.key ?? null,
        digest: result.proposalDigest,
      };
    });

    expect(new Set(winners.map((winner) => `${winner.owner}:${winner.key}`)).size).toBe(1);
    expect(new Set(winners.map((winner) => winner.digest)).size).toBe(1);
  });

  it('acquires highest priority eligible when no lease exists', () => {
    const progression = proposal(MovementIntentOwner.PROGRESSION);
    const retreat = proposal(MovementIntentOwner.RETREAT);

    const result = resolveMovementIntent(
      { current: null, navigation: null },
      [progression, retreat],
      outsideSafe,
    );

    expect(result.transition).toBe('acquired');
    expect(result.reason).toBe('acquiredBestEligible');
    expect(result.selected).toBe(retreat);
    expect(result.nextState.current?.owner).toBe(MovementIntentOwner.RETREAT);
    expect(result.nextState.navigation?.target).toEqual(retreat.target);
  });

  it('completes egress as released then acquired in the same resolution', () => {
    const egress = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
      commitment: {
        policy,
        facts: {
          latched: true,
          ownsMovement: true,
          targetValid: true,
          distanceFt: 3,
          arrived: false,
          clearCondition: false,
          frame: 1,
        },
      },
    });
    let state = acquireState(egress, outsideSafe);
    state = resolveMovementIntent(
      state,
      [
        proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
          key: egress.key,
          target: egress.target,
          commitment: {
            policy,
            facts: {
              latched: true,
              ownsMovement: true,
              targetValid: true,
              distanceFt: 2,
              arrived: false,
              clearCondition: true,
              frame: 2,
            },
          },
        }),
      ],
      outsideSafe,
    ).nextState;

    const retreat = proposal(MovementIntentOwner.RETREAT, {
      commitment: {
        policy,
        facts: {
          latched: true,
          ownsMovement: true,
          targetValid: true,
          distanceFt: 4,
          arrived: false,
          clearCondition: false,
          frame: 3,
        },
      },
    });

    const result = resolveMovementIntent(
      state,
      [
        proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
          key: egress.key,
          target: egress.target,
          commitment: {
            policy,
            facts: {
              latched: true,
              ownsMovement: true,
              targetValid: true,
              distanceFt: 2,
              arrived: false,
              clearCondition: true,
              frame: 3,
            },
          },
        }),
        retreat,
      ],
      outsideSafe,
    );

    expect(result.transition).toBe('acquired');
    expect(result.reason).toBe('acquiredAfterCommitmentRelease');
    expect(result.priorOwner).toBe(MovementIntentOwner.SAFE_ROOM_EGRESS);
    expect(result.selected).toBe(retreat);
    expect(result.nextState.current?.owner).toBe(MovementIntentOwner.RETREAT);
    expect(result.nextState.navigation?.target).toEqual(retreat.target);
  });

  it('starts a fresh challenger commitment after release', () => {
    const current = proposal(MovementIntentOwner.INTERACTION_APPROACH);
    let state = acquireState(current, outsideSafe);

    state = resolveMovementIntent(
      state,
      [
        proposal(MovementIntentOwner.INTERACTION_APPROACH, {
          key: current.key,
          target: current.target,
          commitment: {
            policy,
            facts: {
              latched: true,
              ownsMovement: true,
              targetValid: false,
              distanceFt: 2,
              arrived: false,
              clearCondition: false,
              frame: 2,
            },
          },
        }),
      ],
      outsideSafe,
    ).nextState;

    const challenger = proposal(MovementIntentOwner.RETREAT, {
      commitment: {
        policy,
        facts: {
          latched: true,
          ownsMovement: true,
          targetValid: true,
          distanceFt: 7,
          arrived: false,
          clearCondition: false,
          frame: 3,
        },
      },
    });

    const reacquired = resolveMovementIntent(state, [challenger], outsideSafe);

    expect(reacquired.selected).toBe(challenger);
    expect(reacquired.nextState.navigation?.acquiredFrame).toBe(3);
    expect(reacquired.nextState.navigation?.ownerNoProgressFrames).toBe(0);
    expect(reacquired.nextState.navigation?.target).toEqual(challenger.target);
  });

  it('implements explicit pairwise preemption semantics', () => {
    for (const current of owners) {
      for (const challenger of owners) {
        const challengerProposal = proposal(challenger);
        expect(canPreemptMovementIntent({ owner: current }, challengerProposal, outsideSafe)).toBe(
          expectedPreemption(current, challenger, outsideSafe),
        );
        expect(canPreemptMovementIntent({ owner: current }, challengerProposal, insideSafe)).toBe(
          expectedPreemption(current, challenger, insideSafe),
        );
      }
    }
  });

  it('never uses yielded or temporary executor lifecycle states', () => {
    const current = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS);
    const state = acquireState(current, insideSafe);
    const immediate = proposal(MovementIntentOwner.INTERACTION_IMMEDIATE, {
      commitment: {
        policy,
        facts: {
          latched: true,
          ownsMovement: true,
          targetValid: true,
          distanceFt: 2,
          arrived: false,
          clearCondition: false,
          frame: 2,
        },
      },
    });
    const result = resolveMovementIntent(
      state,
      [
        proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
          key: current.key,
          target: current.target,
          commitment: {
            policy,
            facts: {
              latched: true,
              ownsMovement: true,
              targetValid: true,
              distanceFt: 2,
              arrived: false,
              clearCondition: false,
              frame: 2,
            },
          },
        }),
        immediate,
      ],
      insideSafe,
    );

    expect(result.transition).toBe('preempted');
    expect(result.transition).not.toBe('yielded');
    expect(result.nextState.current).toMatchObject({
      owner: MovementIntentOwner.INTERACTION_IMMEDIATE,
    });
    expect('yielded' in (result.nextState.current ?? {})).toBe(false);

    const telemetry = movementIntentTelemetry(result);
    expect('latchedOwner' in telemetry).toBe(false);
    expect('latchedKey' in telemetry).toBe(false);
    expect('latchedYielding' in telemetry).toBe(false);
  });
});
