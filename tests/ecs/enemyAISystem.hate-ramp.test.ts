/**
 * Floor 2 Slice 3 — hate-band speed ramp (FR9).
 *
 * The ramp raises a slow hate mob's effective speed toward the player's speed
 * as relation drops, capped at the player's speed and never lowering base.
 * This test exercises the pipeline path: familyFeudSystem stamps
 * `effectiveSpeed` on the mob's decision, then enemyAISystem folds it in via
 * `getEnemySpeed`. Movement isn't asserted directly (that's covered by the
 * ordinary chase tests); we assert the decision's ramp value is correct.
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
  Velocity,
} from '../../src/core/index.js';
import { AI_TYPE, familyFeudSystem, getFamilyAIDecision } from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

const FAM_A = asFamilyId('a');

function seedFloor2(world: ReturnType<typeof createTestWorld>): void {
  world.floor2State = {
    presentFamilies: [FAM_A],
    contestedResource: asFamilyId('ore') as unknown as never,
    betrayerFlag: false,
  } as never;
  initializeFactionRelations(world, [FAM_A]);
}

function spawnHateMob(
  world: ReturnType<typeof createTestWorld>,
  baseSpeed: number,
  x = 10,
  y = 0,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, baseSpeed, 999, 0);
  addComponent(world.ecs, eid, set(FamilyMembership, { familyId: 0, isBoss: 0 }));
  return eid;
}

function movingPlayer(world: ReturnType<typeof createTestWorld>, vx: number, vy: number): number {
  const player = spawnPlayer(world, 0, 0);
  addComponent(world.ecs, player, set(Velocity, { x: vx, y: vy }));
  return player;
}

describe('familyFeudSystem — hate-band speed ramp (FR9)', () => {
  it('at relation=0 raises a slow hate mob to match player speed', () => {
    const world = createTestWorld();
    seedFloor2(world);
    movingPlayer(world, 0.5, 0); // playerSpeed = 0.5
    const mob = spawnHateMob(world, 0.1); // baseSpeed = 0.1
    // Drop to 0 → hate band, relation = 0
    adjustFactionRelation(world, FAM_A, -DEFAULT_RELATION);
    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, mob);
    expect(decision).toBeDefined();
    // At r=0 the boost is 100%, so effectiveSpeed = playerSpeed.
    expect(decision?.effectiveSpeed).toBeCloseTo(0.5, 5);
  });

  it('at relation=24 (top of hate band) produces a tiny boost', () => {
    const world = createTestWorld();
    seedFloor2(world);
    movingPlayer(world, 0.5, 0);
    const mob = spawnHateMob(world, 0.1);
    adjustFactionRelation(world, FAM_A, 24 - DEFAULT_RELATION); // = 24
    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, mob);
    // Ramp = (25 - 24)/25 = 0.04; boost = 0.04 * (0.5 - 0.1) = 0.016.
    expect(decision?.effectiveSpeed).toBeCloseTo(0.1 + 0.04 * 0.4, 5);
  });

  it('at relation=25 (out of hate band) no ramp — effectiveSpeed absent', () => {
    const world = createTestWorld();
    seedFloor2(world);
    movingPlayer(world, 0.5, 0);
    const mob = spawnHateMob(world, 0.1);
    adjustFactionRelation(world, FAM_A, 25 - DEFAULT_RELATION); // = 25 (hostile)
    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, mob);
    // Hostile band + no override target ⇒ decision may be entirely absent.
    if (decision !== undefined) {
      expect(decision.effectiveSpeed).toBeUndefined();
    }
  });

  it('mob already at or faster than the player is unaffected', () => {
    const world = createTestWorld();
    seedFloor2(world);
    movingPlayer(world, 0.1, 0);
    const mob = spawnHateMob(world, 0.5); // faster than player
    adjustFactionRelation(world, FAM_A, -DEFAULT_RELATION);
    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, mob);
    // effectiveSpeed only set when boosted != base; base >= playerSpeed ⇒ no set.
    if (decision !== undefined) {
      expect(decision.effectiveSpeed).toBeUndefined();
    }
  });

  it('stationary player leaves the ramp inert (no divide by 0)', () => {
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0); // no velocity component ⇒ playerSpeed = 0
    const mob = spawnHateMob(world, 0.1);
    adjustFactionRelation(world, FAM_A, -DEFAULT_RELATION);
    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, mob);
    if (decision !== undefined) {
      expect(decision.effectiveSpeed).toBeUndefined();
    }
  });
});
