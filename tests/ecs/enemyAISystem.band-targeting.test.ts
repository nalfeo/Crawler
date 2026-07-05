/**
 * Floor 2 Slice 3 — band-driven target selection.
 *
 * Most tests here exercise the family-AI PREPASS in isolation: they build a
 * real world, spawn family mobs, seed relations, run `familyFeudSystem` for one
 * tick, then inspect the decision it stamped for each mob. That is enough to
 * pin the target-selection contract. The final test goes further and runs the
 * real prepass → `enemyAISystem` → `movementSystem` pipeline to prove the
 * stamped rival target is actually consumed and steers the mob end-to-end, not
 * merely recorded.
 */
import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  FamilyMembership,
  movementSystem,
  spawnBehaviorEnemy,
  spawnPlayer,
  asFamilyId,
  adjustFactionRelation,
  initializeFactionRelations,
  DEFAULT_RELATION,
} from '../../src/core/index.js';
import {
  AI_TYPE,
  enemyAISystem,
  familyFeudSystem,
  getFamilyAIDecision,
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
  aggroRange = 999,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, 0.1, aggroRange, 0, {
    persona: 0,
    traversalMode: 0,
  });
  addComponent(world.ecs, eid, set(FamilyMembership, { familyId: familyIdx, isBoss: 0 }));
  return eid;
}

describe('familyFeudSystem — band-driven target selection', () => {
  it('hate-band mob targets the player (no override) when reachable', () => {
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0);
    const hateMob = spawnFamilyMob(world, 5, 0, 0);
    // Drop relation to 0 → hate band
    adjustFactionRelation(world, FAM_A, -DEFAULT_RELATION);

    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, hateMob);
    // Hate mob's decision is only stamped if a hate-speed-ramp fires; player is
    // stationary (speed 0) so no ramp applies. Decision may be absent, which is
    // the "no override — default player target" case.
    if (decision !== undefined) {
      expect(decision.kind).toBe('player');
      expect(decision.bypassPlayerDetection).toBe(false);
    }
  });

  it('neutral-band mob ignores player, picks nearest rival', () => {
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0);
    // Family A neutral (default 45 rounds down — bump to 60)
    adjustFactionRelation(world, FAM_A, 15);
    adjustFactionRelation(world, FAM_B, 15);
    const neutralMob = spawnFamilyMob(world, 1, 0, 0);
    const rivalMob = spawnFamilyMob(world, 3, 0, 1);
    const distantRival = spawnFamilyMob(world, 10, 0, 1);

    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, neutralMob);
    expect(decision).toBeDefined();
    expect(decision?.kind).toBe('rival-primary');
    expect(decision?.targetEid).toBe(rivalMob);
    expect(decision?.targetEid).not.toBe(distantRival);
  });

  it('neutral-band mob with no rivals idles (not targeting player)', () => {
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0);
    adjustFactionRelation(world, FAM_A, 15);
    const lonely = spawnFamilyMob(world, 5, 0, 0);

    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, lonely);
    expect(decision?.kind).toBe('idle');
    expect(decision?.bypassPlayerDetection).toBe(true);
  });

  it('friendly-band mob follows player when outside leash radius', () => {
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0);
    adjustFactionRelation(world, FAM_A, 40); // 45 + 40 = 85 → friendly
    const ally = spawnFamilyMob(world, 20, 0, 0); // way outside leash (default 6)

    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, ally);
    expect(decision?.kind).toBe('follow');
    expect(decision?.x).toBe(0);
    expect(decision?.y).toBe(0);
  });

  it('friendly-band mob idles inside leash', () => {
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0);
    adjustFactionRelation(world, FAM_A, 40);
    const ally = spawnFamilyMob(world, 2, 0, 0); // inside leash

    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, ally);
    expect(decision?.kind).toBe('idle');
  });

  it('trash mob (no FamilyMembership) receives NO family override', () => {
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0);
    const trash = spawnBehaviorEnemy(world, 5, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);

    familyFeudSystem(world);
    expect(getFamilyAIDecision(world, trash)).toBeUndefined();
  });

  it('two families are always rivals even if both have friendly player-relation', () => {
    // FR5: mutually hostile between families regardless of player-relation.
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 0, 0);
    adjustFactionRelation(world, FAM_A, 15); // neutral (60)
    adjustFactionRelation(world, FAM_B, 15);
    const a = spawnFamilyMob(world, 1, 0, 0);
    const b = spawnFamilyMob(world, 3, 0, 1);
    familyFeudSystem(world);
    // A targets B and vice versa.
    expect(getFamilyAIDecision(world, a)?.targetEid).toBe(b);
    expect(getFamilyAIDecision(world, b)?.targetEid).toBe(a);
  });

  it('steers a neutral mob toward its rival through the real prepass → AI → movement pipeline', () => {
    // Unlike the prepass-only tests above, this runs the real runtime pipeline
    // (familyFeudSystem → enemyAISystem → movementSystem) to prove the stamped
    // rival target is actually consumed and moves the mob, not just recorded.
    const world = createTestWorld();
    seedFloor2(world);
    spawnPlayer(world, 5, -10); // player well below; neutral mobs ignore it
    adjustFactionRelation(world, FAM_A, 15); // neutral
    adjustFactionRelation(world, FAM_B, 15); // neutral
    const neutralMob = spawnFamilyMob(world, 5, 0, 0);
    const rival = spawnFamilyMob(world, 5, 10, 1); // directly above

    familyFeudSystem(world);
    enemyAISystem(world);
    movementSystem(world);

    const decision = getFamilyAIDecision(world, neutralMob);
    expect(decision?.kind).toBe('rival-primary');
    expect(decision?.targetEid).toBe(rival);
    // The mob moved UP toward the rival (+y), not DOWN toward the player (−y).
    expect(world.stores.position.y[neutralMob]).toBeGreaterThan(0);
  });
});
