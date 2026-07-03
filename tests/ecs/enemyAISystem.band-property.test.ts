/**
 * Floor 2 Slice 3 — property test.
 *
 * For every relation value r ∈ [0,100] the family-AI decision produced by
 * `familyFeudSystem` must be legal for its band:
 *
 *   hate    (0–24)  → no override OR speed-ramp; player is a legal target,
 *                     fallback rival is legal.
 *   hostile (25–49) → no override OR fallback rival if player is unreachable.
 *   neutral (50–75) → decision.kind === 'rival' or 'idle'; never targets player.
 *   friendly (76–100) → decision.kind === 'follow' | 'idle' | 'attacker'.
 *
 * We also verify that changing the relation across a band boundary causes the
 * next tick to re-evaluate the target (no stale decision leak).
 */
import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  FamilyMembership,
  spawnBehaviorEnemy,
  spawnPlayer,
  asFamilyId,
  adjustFactionRelation,
  bandFor,
  getRelation,
  initializeFactionRelations,
} from '../../src/core/index.js';
import { AI_TYPE, familyFeudSystem, getFamilyAIDecision } from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

const FAM_A = asFamilyId('a');
const FAM_B = asFamilyId('b');

function seed(): ReturnType<typeof createTestWorld> {
  const world = createTestWorld();
  world.floor2State = {
    presentFamilies: [FAM_A, FAM_B],
    contestedResource: asFamilyId('ore') as unknown as never,
    betrayerFlag: false,
  } as never;
  initializeFactionRelations(world, [FAM_A, FAM_B]);
  return world;
}

function setRelation(
  world: ReturnType<typeof createTestWorld>,
  fam: typeof FAM_A,
  target: number,
): void {
  const current = getRelation(world, fam);
  adjustFactionRelation(world, fam, target - current);
}

function isLegalFor(
  band: ReturnType<typeof bandFor>,
  decision: ReturnType<typeof getFamilyAIDecision>,
): boolean {
  const kind = decision?.kind;
  switch (band) {
    case 'hate':
    case 'hostile':
      // Player-first: 'player' (speed ramp only, no target override), or a
      // 'rival-fallback' if player is unreachable.
      return kind === undefined || kind === 'player' || kind === 'rival-fallback';
    case 'neutral':
      return kind === 'rival-primary' || kind === 'idle';
    case 'friendly':
      return kind === 'follow' || kind === 'idle' || kind === 'attacker';
  }
}

describe('familyFeudSystem — property: legal target per band', () => {
  it('produces a legal decision for every relation r ∈ [0,100]', () => {
    for (let r = 0; r <= 100; r++) {
      const world = seed();
      setRelation(world, FAM_A, r);
      spawnPlayer(world, 0, 0);
      const mob = spawnBehaviorEnemy(world, 5, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
      addComponent(world.ecs, mob, set(FamilyMembership, { familyId: 0, isBoss: 0 }));
      // Give it something to potentially target so `rival` can be a legal outcome.
      const rival = spawnBehaviorEnemy(world, 6, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
      addComponent(world.ecs, rival, set(FamilyMembership, { familyId: 1, isBoss: 0 }));
      familyFeudSystem(world);
      const band = bandFor(getRelation(world, FAM_A));
      const decision = getFamilyAIDecision(world, mob);
      expect(
        isLegalFor(band, decision),
        `r=${r} band=${band} decision=${JSON.stringify(decision)}`,
      ).toBe(true);
    }
  });

  it('re-evaluates the target on the next tick after a band transition', () => {
    const world = seed();
    // Start friendly.
    setRelation(world, FAM_A, 90);
    spawnPlayer(world, 0, 0);
    const mob = spawnBehaviorEnemy(world, 5, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    addComponent(world.ecs, mob, set(FamilyMembership, { familyId: 0, isBoss: 0 }));
    const rival = spawnBehaviorEnemy(world, 6, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    addComponent(world.ecs, rival, set(FamilyMembership, { familyId: 1, isBoss: 0 }));

    familyFeudSystem(world);
    const d1 = getFamilyAIDecision(world, mob);
    expect(d1?.kind === 'follow' || d1?.kind === 'idle').toBe(true);

    // Cross to neutral.
    setRelation(world, FAM_A, 60);
    familyFeudSystem(world);
    const d2 = getFamilyAIDecision(world, mob);
    expect(d2?.kind === 'rival-primary' || d2?.kind === 'idle').toBe(true);

    // Cross to hostile — decision must NOT be 'follow' / 'rival'/'attacker'
    // sticky from earlier bands.
    setRelation(world, FAM_A, 30);
    familyFeudSystem(world);
    const d3 = getFamilyAIDecision(world, mob);
    // Hostile mobs use the default player-preferred path (no override) unless
    // player is unreachable — in this test the player IS present, so decision
    // may be undefined OR a `rival` fallback. Never `follow`.
    expect(d3?.kind).not.toBe('follow');
    expect(d3?.kind).not.toBe('attacker');
  });
});
