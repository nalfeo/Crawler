import { describe, expect, it } from 'vitest';
import {
  MOVEMENT_INTENT_ACQUISITION_PRIORITIES,
  MovementIntentOwner,
  canPreemptMovementIntent,
  movementIntentTargetFingerprint,
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
  return result.nextState;
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

  it('acquires the highest-priority eligible proposal', () => {
    const progression = proposal(MovementIntentOwner.PROGRESSION);
    const retreat = proposal(MovementIntentOwner.RETREAT);
    const result = resolveMovementIntent(
      { current: null, navigation: null },
      [progression, retreat],
      outsideSafe,
    );

    expect(result.selected).toBe(retreat);
    expect(result.transition).toBe('acquired');
    expect(result.reason).toBe('acquiredBestEligible');
    expect(result.priorOwner).toBeNull();
  });

  it('uses deterministic tie-breaks after priority', () => {
    const late = proposal(MovementIntentOwner.INTERACTION_APPROACH, {
      key: 'b',
      priority: 350,
      declarationOrdinal: 2,
      target: targetFor(MovementIntentOwner.INTERACTION_APPROACH, 8),
    });
    const early = proposal(MovementIntentOwner.INTERACTION_APPROACH, {
      key: 'z',
      priority: 350,
      declarationOrdinal: 1,
      target: targetFor(MovementIntentOwner.INTERACTION_APPROACH, 9),
    });
    const result = resolveMovementIntent(
      { current: null, navigation: null },
      [late, early],
      outsideSafe,
    );

    expect(result.selected).toBe(early);

    const byOwnerKey = resolveMovementIntent(
      { current: null, navigation: null },
      [
        proposal(MovementIntentOwner.INTERACTION_APPROACH, {
          key: 'b',
          priority: 350,
          declarationOrdinal: 1,
          target: targetFor(MovementIntentOwner.INTERACTION_APPROACH, 8),
        }),
        proposal(MovementIntentOwner.INTERACTION_APPROACH, {
          key: 'a',
          priority: 350,
          declarationOrdinal: 1,
          target: targetFor(MovementIntentOwner.INTERACTION_APPROACH, 9),
        }),
      ],
      outsideSafe,
    );
    expect(byOwnerKey.selected?.key).toBe('a');

    const byTarget = resolveMovementIntent(
      { current: null, navigation: null },
      [
        proposal(MovementIntentOwner.INTERACTION_APPROACH, {
          key: 'same',
          priority: 350,
          declarationOrdinal: 1,
          target: targetFor(MovementIntentOwner.INTERACTION_APPROACH, 12),
        }),
        proposal(MovementIntentOwner.INTERACTION_APPROACH, {
          key: 'same',
          priority: 350,
          declarationOrdinal: 1,
          target: targetFor(MovementIntentOwner.INTERACTION_APPROACH, 3),
        }),
      ],
      outsideSafe,
    );
    expect(byTarget.selected?.target.tileX).toBe(3);
  });

  it('retains a current lease when challengers are default-denied', () => {
    const egress = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS);
    const state = acquireState(egress, outsideSafe);
    const retreat = proposal(MovementIntentOwner.RETREAT, {
      commitment: {
        policy,
        facts: {
          ...egress.commitment.facts,
          frame: 2,
        },
      },
    });
    const retainedEgress = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
      commitment: {
        policy,
        facts: {
          ...egress.commitment.facts,
          frame: 2,
        },
      },
    });

    const result = resolveMovementIntent(state, [retainedEgress, retreat], outsideSafe);

    expect(result.selected).toBe(retainedEgress);
    expect(result.transition).toBe('retained');
    expect(result.nextState.current?.owner).toBe(MovementIntentOwner.SAFE_ROOM_EGRESS);
  });

  it('releases current lease when commitment clears', () => {
    const egress = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS);
    let state = acquireState(egress, outsideSafe);
    const firstClear = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
      commitment: {
        policy,
        facts: {
          ...egress.commitment.facts,
          clearCondition: true,
          frame: 2,
        },
      },
    });
    state = resolveMovementIntent(state, [firstClear], outsideSafe).nextState;

    const secondClear = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
      commitment: {
        policy,
        facts: {
          ...egress.commitment.facts,
          clearCondition: true,
          frame: 3,
        },
      },
    });
    const result = resolveMovementIntent(state, [secondClear], outsideSafe);

    expect(result.transition).toBe('released');
    expect(result.reason).toBe('releasedByCommitment');
    expect(result.selected).toBeNull();
    expect(result.nextState.current).toBeNull();
  });

  it('acquires an eligible successor on the exact frame the retained commitment clears', () => {
    const egress = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS);
    let state = acquireState(egress, outsideSafe);
    state = resolveMovementIntent(
      state,
      [
        proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
          commitment: {
            policy,
            facts: { ...egress.commitment.facts, clearCondition: true, frame: 2 },
          },
        }),
      ],
      outsideSafe,
    ).nextState;

    const retreat = proposal(MovementIntentOwner.RETREAT, {
      commitment: {
        policy,
        facts: { ...egress.commitment.facts, frame: 3 },
      },
    });
    const result = resolveMovementIntent(
      state,
      [
        proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
          commitment: {
            policy,
            facts: { ...egress.commitment.facts, clearCondition: true, frame: 3 },
          },
        }),
        retreat,
      ],
      outsideSafe,
    );

    expect(result.transition).toBe('acquired');
    expect(result.selected).toBe(retreat);
    expect(result.priorOwner).toBe(MovementIntentOwner.SAFE_ROOM_EGRESS);
    expect(result.nextState.current?.owner).toBe(MovementIntentOwner.RETREAT);
    expect(result.nextState.navigation).not.toBeNull();
  });

  it('releases current lease when commitment target invalidates or stalls', () => {
    const current = proposal(MovementIntentOwner.INTERACTION_APPROACH);
    const invalidState = acquireState(current, outsideSafe);
    const invalidResult = resolveMovementIntent(
      invalidState,
      [
        proposal(MovementIntentOwner.INTERACTION_APPROACH, {
          commitment: {
            policy,
            facts: {
              ...current.commitment.facts,
              targetValid: false,
              frame: 2,
            },
          },
        }),
      ],
      outsideSafe,
    );
    expect(invalidResult.transition).toBe('released');
    expect(invalidResult.commitment?.reason).toBe('targetInvalid');

    let stallState = acquireState(current, outsideSafe);
    for (let frame = 2; frame <= 3; frame += 1) {
      stallState = resolveMovementIntent(
        stallState,
        [
          proposal(MovementIntentOwner.INTERACTION_APPROACH, {
            commitment: {
              policy,
              facts: {
                ...current.commitment.facts,
                frame,
              },
            },
          }),
        ],
        outsideSafe,
      ).nextState;
    }
    const stalled = resolveMovementIntent(
      stallState,
      [
        proposal(MovementIntentOwner.INTERACTION_APPROACH, {
          commitment: {
            policy,
            facts: {
              ...current.commitment.facts,
              frame: 4,
            },
          },
        }),
      ],
      outsideSafe,
    );
    expect(stalled.transition).toBe('released');
    expect(stalled.commitment?.reason).toBe('stalled');
  });

  it('applies the exhaustive pairwise preemption matrix deterministically', () => {
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

  it('preempts retained egress only by immediate interaction inside safe', () => {
    const egress = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS);
    const insideState = acquireState(egress, insideSafe);
    const retainedEgress = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
      commitment: { policy, facts: { ...egress.commitment.facts, frame: 2 } },
    });
    const immediate = proposal(MovementIntentOwner.INTERACTION_IMMEDIATE, {
      commitment: { policy, facts: { ...egress.commitment.facts, frame: 2 } },
    });

    const result = resolveMovementIntent(insideState, [retainedEgress, immediate], insideSafe);

    expect(result.transition).toBe('preempted');
    expect(result.selected).toBe(immediate);
    expect(result.nextState.navigation?.target).toEqual(immediate.target);
  });

  it('preempts retained egress by arena only when physically caged outside safe', () => {
    const egress = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS);
    const state = acquireState(egress, outsideSafe);
    const retainedEgress = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
      commitment: { policy, facts: { ...egress.commitment.facts, frame: 2 } },
    });
    const arenaWithoutLock = proposal(MovementIntentOwner.ARENA_LOCKIN, {
      eligibility: {
        zone: 'outsideSafe',
        targetRelation: 'outsideCurrentSafeSpace',
        domainAvailable: true,
        physicalLock: false,
      },
      commitment: { policy, facts: { ...egress.commitment.facts, frame: 2 } },
    });

    const denied = resolveMovementIntent(state, [retainedEgress, arenaWithoutLock], outsideSafe);
    expect(denied.transition).toBe('retained');

    const arenaWithLock = proposal(MovementIntentOwner.ARENA_LOCKIN, {
      eligibility: {
        zone: 'outsideSafe',
        targetRelation: 'outsideCurrentSafeSpace',
        domainAvailable: true,
        physicalLock: true,
      },
      commitment: { policy, facts: { ...egress.commitment.facts, frame: 2 } },
    });
    const allowed = resolveMovementIntent(state, [retainedEgress, arenaWithLock], outsideSafe);

    expect(allowed.transition).toBe('preempted');
    expect(allowed.selected).toBe(arenaWithLock);
  });

  it('preserves outside-safe retreat-over-arena retention semantics', () => {
    const arena = proposal(MovementIntentOwner.ARENA_LOCKIN);
    const state = acquireState(arena, outsideSafe);
    const retainedArena = proposal(MovementIntentOwner.ARENA_LOCKIN, {
      commitment: { policy, facts: { ...arena.commitment.facts, frame: 2 } },
    });
    const retreat = proposal(MovementIntentOwner.RETREAT, {
      commitment: { policy, facts: { ...arena.commitment.facts, frame: 2 } },
    });

    const result = resolveMovementIntent(state, [retainedArena, retreat], outsideSafe);

    expect(result.transition).toBe('preempted');
    expect(result.selected).toBe(retreat);
  });

  it('rejects invalid targets, unavailable domains, and wrong zones before acquisition', () => {
    const invalid = proposal(MovementIntentOwner.RETREAT, {
      target: { ...targetFor(MovementIntentOwner.RETREAT), valid: false },
    });
    const unavailable = proposal(MovementIntentOwner.ARENA_LOCKIN, {
      eligibility: {
        zone: 'any',
        targetRelation: 'any',
        domainAvailable: false,
        physicalLock: true,
      },
    });
    const wrongZone = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
      eligibility: {
        zone: 'insideSafe',
        targetRelation: 'outsideCurrentSafeSpace',
        domainAvailable: true,
      },
    });

    const result = resolveMovementIntent(
      { current: null, navigation: null },
      [invalid, unavailable, wrongZone],
      outsideSafe,
    );

    expect(result.transition).toBe('rejected');
    expect(result.selected).toBeNull();
  });

  it('uses target fingerprint for retained lease matching', () => {
    const current = proposal(MovementIntentOwner.INTERACTION_APPROACH, {
      target: targetFor(MovementIntentOwner.INTERACTION_APPROACH, 4),
    });
    const state = acquireState(current, outsideSafe);
    const sameTileMoved = proposal(MovementIntentOwner.INTERACTION_APPROACH, {
      target: {
        ...targetFor(MovementIntentOwner.INTERACTION_APPROACH, 4),
        x: 99,
        y: 100,
      },
      commitment: { policy, facts: { ...current.commitment.facts, frame: 2 } },
    });
    const changedTile = proposal(MovementIntentOwner.INTERACTION_APPROACH, {
      target: targetFor(MovementIntentOwner.INTERACTION_APPROACH, 5),
      commitment: { policy, facts: { ...current.commitment.facts, frame: 2 } },
    });

    expect(movementIntentTargetFingerprint(sameTileMoved.target)).toBe(
      movementIntentTargetFingerprint(current.target),
    );
    expect(movementIntentTargetFingerprint(changedTile.target)).not.toBe(
      movementIntentTargetFingerprint(current.target),
    );
    expect(resolveMovementIntent(state, [sameTileMoved], outsideSafe).transition).toBe('retained');
    expect(resolveMovementIntent(state, [changedTile], outsideSafe).transition).toBe('acquired');
  });

  it('does not mutate proposals or previous state', () => {
    const current = proposal(MovementIntentOwner.PROGRESSION);
    const challenger = proposal(MovementIntentOwner.RETREAT);
    const state = acquireState(current, outsideSafe);
    const proposalBefore = structuredClone(challenger);
    const stateBefore = structuredClone(state);

    resolveMovementIntent(state, [current, challenger], outsideSafe);

    expect(challenger).toEqual(proposalBefore);
    expect(state).toEqual(stateBefore);
  });

  it('replays deterministically for the same proposal stream', () => {
    const stream = [
      [proposal(MovementIntentOwner.PROGRESSION)],
      [
        proposal(MovementIntentOwner.PROGRESSION, {
          commitment: {
            policy,
            facts: {
              ...proposal(MovementIntentOwner.PROGRESSION).commitment.facts,
              frame: 2,
            },
          },
        }),
        proposal(MovementIntentOwner.RETREAT, {
          commitment: {
            policy,
            facts: {
              ...proposal(MovementIntentOwner.RETREAT).commitment.facts,
              frame: 2,
            },
          },
        }),
      ],
    ];

    const replay = (): ReadonlyArray<unknown> => {
      let state: MovementIntentArbiterState = { current: null, navigation: null };
      return stream.map((proposals) => {
        const result = resolveMovementIntent(state, proposals, outsideSafe);
        state = result.nextState;
        return result;
      });
    };

    expect(replay()).toEqual(replay());
  });

  it('throws on malformed proposals instead of silently defaulting', () => {
    expect(() =>
      resolveMovementIntent(
        { current: null, navigation: null },
        [proposal(MovementIntentOwner.PROGRESSION, { declarationOrdinal: -1 })],
        outsideSafe,
      ),
    ).toThrow(/declarationOrdinal/);
    expect(() =>
      resolveMovementIntent(
        { current: null, navigation: null },
        [
          proposal(MovementIntentOwner.PROGRESSION, {
            target: { ...targetFor(MovementIntentOwner.PROGRESSION), tileX: -1 },
          }),
        ],
        outsideSafe,
      ),
    ).toThrow(/target.tileX/);
  });

  it('does not retain a lease whose commitment clears on acquisition', () => {
    const immediatelyClear = proposal(MovementIntentOwner.SAFE_ROOM_EGRESS, {
      commitment: {
        policy: { ...policy, clearWindowFrames: 0 },
        facts: {
          ...proposal(MovementIntentOwner.SAFE_ROOM_EGRESS).commitment.facts,
          clearCondition: true,
        },
      },
    });

    const result = resolveMovementIntent(
      { current: null, navigation: null },
      [immediatelyClear],
      outsideSafe,
    );

    expect(result.transition).toBe('released');
    expect(result.selected).toBeNull();
    expect(result.nextState).toEqual({ current: null, navigation: null });
  });
});
