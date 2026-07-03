/**
 * Floor 2 Slice 3 — friendly-band ally follow + defend.
 *
 * Verifies the retaliation state transition: a friendly-band ally follows the
 * player until a `hit`-event with `sourceEid` targets the player, then
 * re-targets that attacker for `friendlyRetaliationMs`, then reverts to follow
 * once the window elapses.
 */
import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import type { CombatEvent } from '../../src/shared/combat-events.js';
import tuning from '../../src/shared/data/tuning.json';
import {
  FamilyMembership,
  spawnBehaviorEnemy,
  spawnPlayer,
  asFamilyId,
  adjustFactionRelation,
  initializeFactionRelations,
} from '../../src/core/index.js';
import {
  AI_TYPE,
  familyFeudSystem,
  getFamilyAIDecision,
  peekFriendlyRetaliation,
  resetFamilyFeudState,
} from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

const FAM_A = asFamilyId('a');
const FAM_B = asFamilyId('b');

function seedFloor2(world: ReturnType<typeof createTestWorld>): void {
  world.floor2State = {
    presentFamilies: [FAM_A, FAM_B],
    contestedResource: asFamilyId('ore') as unknown as never,
    betrayerFlag: false,
  } as never;
  initializeFactionRelations(world, [FAM_A, FAM_B]);
}

function spawnFriendlyAlly(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, 0.1, 999, 0);
  addComponent(world.ecs, eid, set(FamilyMembership, { familyId: 0, isBoss: 0 }));
  return eid;
}

function spawnEnemyAttacker(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, 0.1, 999, 0);
  addComponent(world.ecs, eid, set(FamilyMembership, { familyId: 1, isBoss: 0 }));
  return eid;
}

function pushPlayerHitEvent(
  world: ReturnType<typeof createTestWorld>,
  playerEid: number,
  attackerEid: number,
): void {
  const ev: CombatEvent = {
    type: 'hit',
    x: 0,
    y: 0,
    amount: 1,
    targetType: 'player',
    timestamp: world.elapsedMs,
    targetEid: playerEid,
    sourceEid: attackerEid,
  };
  world.combatEvents.push(ev);
}

describe('familyFeudSystem — friendly-band ally follow + defend', () => {
  it('reverts a friendly ally to follow after the retaliation window elapses', () => {
    const world = createTestWorld();
    seedFloor2(world);
    adjustFactionRelation(world, FAM_A, 40); // friendly
    const player = spawnPlayer(world, 0, 0);
    const ally = spawnFriendlyAlly(world, 20, 0); // outside leash — will follow
    const attacker = spawnEnemyAttacker(world, 3, 0);

    // Frame 1: no attack yet — ally follows.
    familyFeudSystem(world);
    expect(getFamilyAIDecision(world, ally)?.kind).toBe('follow');
    expect(peekFriendlyRetaliation(world)).toBeNull();

    // Player takes a hit.
    pushPlayerHitEvent(world, player, attacker);
    world.elapsedMs += 16;
    familyFeudSystem(world);
    const attackDecision = getFamilyAIDecision(world, ally);
    expect(attackDecision?.kind).toBe('attacker');
    expect(attackDecision?.targetEid).toBe(attacker);
    const latch = peekFriendlyRetaliation(world);
    expect(latch?.attackerEid).toBe(attacker);

    // Fast-forward past the retaliation window.
    world.elapsedMs += tuning.factionRelations.friendlyRetaliationMs + 100;
    familyFeudSystem(world);
    expect(getFamilyAIDecision(world, ally)?.kind).toBe('follow');
    expect(peekFriendlyRetaliation(world)).toBeNull();
  });

  it('ignores hit events with no sourceEid', () => {
    const world = createTestWorld();
    seedFloor2(world);
    adjustFactionRelation(world, FAM_A, 40);
    const player = spawnPlayer(world, 0, 0);
    const ally = spawnFriendlyAlly(world, 20, 0);

    // Legacy event without sourceEid — should not arm retaliation.
    const ev: CombatEvent = {
      type: 'hit',
      x: 0,
      y: 0,
      amount: 1,
      targetType: 'player',
      timestamp: 0,
      targetEid: player,
    };
    world.combatEvents.push(ev);
    familyFeudSystem(world);
    expect(peekFriendlyRetaliation(world)).toBeNull();
    expect(getFamilyAIDecision(world, ally)?.kind).toBe('follow');
  });

  it('resetFamilyFeudState clears both decisions and retaliation', () => {
    const world = createTestWorld();
    seedFloor2(world);
    adjustFactionRelation(world, FAM_A, 40);
    const player = spawnPlayer(world, 0, 0);
    spawnFriendlyAlly(world, 20, 0);
    const attacker = spawnEnemyAttacker(world, 3, 0);
    pushPlayerHitEvent(world, player, attacker);
    familyFeudSystem(world);
    expect(peekFriendlyRetaliation(world)).not.toBeNull();
    resetFamilyFeudState(world);
    expect(peekFriendlyRetaliation(world)).toBeNull();
  });
});
