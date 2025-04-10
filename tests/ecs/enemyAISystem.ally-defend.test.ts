/**
 * Floor 2 Slice 3 — friendly-band ally follow + defend.
 *
 * Verifies the retaliation state transition: a friendly-band ally follows the
 * player until a damaging hit with a `sourceEid` lands on the player, then
 * re-targets that attacker for `friendlyRetaliationMs`, then reverts to follow
 * once the window elapses.
 *
 * Retaliation arms off the DURABLE `world.lastPlayerHit` signal that
 * `applyDamage` writes — NOT the transient `world.combatEvents` queue. The
 * final test reproduces the real visual frame loop, where the render layer
 * drains `world.combatEvents` every frame before the next prepass runs, and
 * proves ally-defend still fires (and targets the shooter, not the destroyed
 * projectile) after that drain. Scanning the queue used to make the feature
 * silently inert in the shipped game while "passing" in headless.
 */
import { addComponent, hasComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import tuning from '../../src/shared/data/tuning.json';
import {
  FamilyMembership,
  Position,
  applyDamage,
  DEFAULT_DAMAGE_OPTIONS,
  collisionSystem,
  damageSystem,
  spawnBehaviorEnemy,
  spawnEnemyProjectile,
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
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [FAM_A, FAM_B],
      contestedResource: asFamilyId('ore') as unknown as never,
      betrayerFlag: false,
    } as never,
  };
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

/**
 * Mirror what `applyDamage` records at the damage choke point: a durable
 * per-world "last player hit by" signal that survives the render layer's
 * per-frame drain of `world.combatEvents`.
 */
function recordPlayerHit(world: ReturnType<typeof createTestWorld>, attackerEid: number): void {
  world.lastPlayerHit = { attackerEid, atMs: world.elapsedMs };
}

describe('familyFeudSystem — friendly-band ally follow + defend', () => {
  it('reverts a friendly ally to follow after the retaliation window elapses', () => {
    const world = createTestWorld();
    seedFloor2(world);
    adjustFactionRelation(world, FAM_A, 40); // friendly
    spawnPlayer(world, 0, 0);
    const ally = spawnFriendlyAlly(world, 20, 0); // outside leash — will follow
    const attacker = spawnEnemyAttacker(world, 3, 0);

    // Frame 1: no attack yet — ally follows.
    familyFeudSystem(world);
    expect(getFamilyAIDecision(world, ally)?.kind).toBe('follow');
    expect(peekFriendlyRetaliation(world)).toBeNull();

    // Player takes a hit — the durable signal arms retaliation.
    recordPlayerHit(world, attacker);
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

  it('a player hit with no sourceEid does not arm retaliation', () => {
    const world = createTestWorld();
    seedFloor2(world);
    adjustFactionRelation(world, FAM_A, 40);
    const player = spawnPlayer(world, 0, 0);
    const ally = spawnFriendlyAlly(world, 20, 0);

    // Real choke point, but the damage has no attacker (e.g. environmental) —
    // applyDamage must not record a durable last-hit, so nothing arms.
    const dealt = applyDamage(world, player, 5, 0, 0, DEFAULT_DAMAGE_OPTIONS);
    expect(dealt).toBe(5);
    expect(world.lastPlayerHit).toBeUndefined();

    familyFeudSystem(world);
    expect(peekFriendlyRetaliation(world)).toBeNull();
    expect(getFamilyAIDecision(world, ally)?.kind).toBe('follow');
  });

  it('resetFamilyFeudState clears decisions, retaliation, and the durable hit signal', () => {
    const world = createTestWorld();
    seedFloor2(world);
    adjustFactionRelation(world, FAM_A, 40);
    spawnPlayer(world, 0, 0);
    spawnFriendlyAlly(world, 20, 0);
    const attacker = spawnEnemyAttacker(world, 3, 0);
    recordPlayerHit(world, attacker);
    familyFeudSystem(world);
    expect(peekFriendlyRetaliation(world)).not.toBeNull();
    resetFamilyFeudState(world);
    expect(peekFriendlyRetaliation(world)).toBeNull();
    expect(world.lastPlayerHit).toBeUndefined();
  });

  it('fires in the REAL frame loop: retaliation survives the per-frame combatEvents drain and targets the shooter', () => {
    // Rule #10 regression guard. In the shipped visual game the VFX layer
    // drains world.combatEvents every rendered frame BEFORE the next prepass
    // runs, so a queue-scanning retaliation never saw the hit and ally-defend
    // silently never fired (headless masked it by never draining). This test
    // reproduces that drain and asserts the feature still works end-to-end via
    // the durable world.lastPlayerHit signal — and that it targets the live
    // shooter, not the projectile eid that is destroyed on impact (bug 2).
    const world = createTestWorld();
    world.elapsedMs = 100;
    seedFloor2(world);
    adjustFactionRelation(world, FAM_A, 40); // FAM_A ally is friendly

    const player = spawnPlayer(world, 50, 50);
    const ally = spawnFriendlyAlly(world, 70, 50); // FAM_A, outside leash
    const shooter = spawnBehaviorEnemy(world, 60, 50, 30, AI_TYPE.RANGED, 1, 200, 150);
    addComponent(world.ecs, shooter, set(FamilyMembership, { familyId: 1, isBoss: 0 })); // FAM_B

    // Frame N: an enemy projectile owned by the shooter hits the player.
    const projEid = spawnEnemyProjectile(world, 50, 50, 1, 0, 15, shooter);
    const collisionResult = collisionSystem(world);
    damageSystem(world, collisionResult);
    expect(world.stores.health.current[player]).toBeLessThan(100);
    // The durable signal records the SHOOTER, not the projectile.
    expect(world.lastPlayerHit?.attackerEid).toBe(shooter);
    expect(hasComponent(world.ecs, projEid, Position)).toBe(false); // projectile destroyed

    // End of frame N: the render layer drains the transient combat-event queue
    // (this is exactly what combatVfx.update does in MainGameScene).
    world.combatEvents.length = 0;

    // Frame N+1: the prepass runs AFTER the drain. Ally-defend must still fire.
    world.elapsedMs += 16;
    familyFeudSystem(world);
    const decision = getFamilyAIDecision(world, ally);
    expect(decision?.kind).toBe('attacker');
    expect(decision?.targetEid).toBe(shooter);
    expect(peekFriendlyRetaliation(world)?.attackerEid).toBe(shooter);
  });
});
