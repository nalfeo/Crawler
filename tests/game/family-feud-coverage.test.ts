/**
 * familyFeudSystem — additional branch coverage.
 *
 * The existing band-targeting, band-property, and hate-ramp tests cover the
 * main target-selection logic, but several branches remain untested:
 *
 *  1. Boss mob skip: a mob with `isBoss=1` is skipped when its encounter is
 *     started but not yet defeated.
 *  2. `getMobFamilyId` fallback: returns a synthetic id when
 *     `presentFamilies` is absent (no Floor 2 state).
 *  3. Speed-only hate decision: a hate-band mob with a player moving fast
 *     enough to trigger the speed ramp receives a `kind:'player'` decision
 *     with an `effectiveSpeed` override even though it has no family override.
 */
import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  FamilyMembership,
  spawnBehaviorEnemy,
  spawnPlayer,
  asFamilyId,
  adjustFactionRelation,
  initializeFactionRelations,
  DEFAULT_RELATION,
} from '../../src/core/index.js';
import {
  AI_TYPE,
  familyFeudSystem,
  getFamilyAIDecision,
  getMobFamilyId,
} from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

const FAM_A = asFamilyId('a');
const FAM_B = asFamilyId('b');

function seedFloor2(world: ReturnType<typeof createTestWorld>): void {
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [FAM_A, FAM_B],
      contestedResource: asFamilyId('ore') as unknown as never,
      betrayerFlag: false,
    } as never,
  };
  initializeFactionRelations(world, [FAM_A, FAM_B]);
}

function spawnFamilyMob(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
  familyIdx: 0 | 1,
  speed = 0.1,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, speed, 999, 0);
  addComponent(world.ecs, eid, set(FamilyMembership, { familyId: familyIdx, isBoss: 0 }));
  return eid;
}

describe('familyFeudSystem — boss mob skip', () => {
  it('skips a boss mob when its encounter is started but not yet defeated', () => {
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0);
    // Make FAM_A neutral (50) so the mob would normally produce an idle/rival decision.
    adjustFactionRelation(world, FAM_A, 5); // 45 + 5 = 50 → neutral

    // Spawn a boss-flagged family mob.
    const bossMob = spawnBehaviorEnemy(world, 5, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    addComponent(world.ecs, bossMob, set(FamilyMembership, { familyId: 0, isBoss: 1 }));

    // Inject a started-but-not-defeated boss encounter for FAM_A.
    const floorState = world.floorExtendedState!.familyState!;
    floorState.bossEncounters = new Map([
      [
        FAM_A,
        {
          familyId: FAM_A,
          roomId: 1,
          doorEids: [],
          activeGoalId: 'boss-goal',
          started: true,
          bossEid: bossMob,
          defeated: false,
        },
      ],
    ]);

    familyFeudSystem(world);

    // The boss mob should be skipped entirely — no decision recorded.
    expect(getFamilyAIDecision(world, bossMob)).toBeUndefined();
  });

  it('does not skip a boss mob when the encounter is defeated', () => {
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0);
    adjustFactionRelation(world, FAM_A, 5); // neutral

    const bossMob = spawnBehaviorEnemy(world, 5, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    addComponent(world.ecs, bossMob, set(FamilyMembership, { familyId: 0, isBoss: 1 }));

    const floorState = world.floorExtendedState!.familyState!;
    floorState.bossEncounters = new Map([
      [
        FAM_A,
        {
          familyId: FAM_A,
          roomId: 1,
          doorEids: [],
          activeGoalId: 'boss-goal',
          started: true,
          bossEid: bossMob,
          // Defeated → should NOT be skipped.
          defeated: true,
        },
      ],
    ]);

    familyFeudSystem(world);

    // Neutral boss with no rival → should get an idle decision (not skipped).
    const decision = getFamilyAIDecision(world, bossMob);
    expect(decision).toBeDefined();
    expect(decision?.kind).toBe('idle');
  });
});

describe('familyFeudSystem — getMobFamilyId fallback', () => {
  it('returns a synthetic id when floorExtendedState.familyState is absent', () => {
    const world = createTestWorld();
    // No Floor 2 state: floorExtendedState is null / undefined.
    world.floorExtendedState = null;

    const eid = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    addComponent(world.ecs, eid, set(FamilyMembership, { familyId: 0, isBoss: 0 }));

    const familyId = getMobFamilyId(world, eid);
    // The fallback produces a synthetic id based on the raw slot index.
    expect(familyId).toBeDefined();
    expect(String(familyId)).toContain('__slot:0');
  });

  it('returns undefined for a mob without FamilyMembership', () => {
    const world = createTestWorld();
    const eid = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    // No FamilyMembership component.
    expect(getMobFamilyId(world, eid)).toBeUndefined();
  });
});

describe('familyFeudSystem — hate-band speed-only decision', () => {
  it('stamps a speed-only player decision for a hate-band family mob when the player is moving fast enough to trigger a ramp', () => {
    const world = createTestWorld();
    seedFloor2(world);
    const player = spawnPlayer(world, 0, 0);

    // Hate band: push relation to 0.
    adjustFactionRelation(world, FAM_A, -DEFAULT_RELATION); // 45 - 45 = 0

    // Spawn a slow family mob — base speed must be less than player speed for the ramp.
    const hateMob = spawnFamilyMob(world, 5, 0, 0, /* speed= */ 0.5);

    // Give the player a non-zero velocity so playerSpeed > 0 and > mob baseSpeed.
    world.stores.velocity.x[player] = 2;
    world.stores.velocity.y[player] = 0;

    familyFeudSystem(world);

    const decision = getFamilyAIDecision(world, hateMob);
    // The speed-only path produces a 'player' decision with effectiveSpeed set.
    expect(decision).toBeDefined();
    expect(decision?.kind).toBe('player');
    expect(decision?.bypassPlayerDetection).toBe(false);
    expect(decision?.effectiveSpeed).toBeDefined();
    expect(decision?.effectiveSpeed).toBeGreaterThan(0.5);
  });
});
