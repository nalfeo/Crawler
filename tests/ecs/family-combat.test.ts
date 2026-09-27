import { addComponent, hasComponent, removeEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Damage,
  DeathTimer,
  EnemyProjectile,
  FamilyMembership,
  Team,
} from '../../src/core/components.js';
import {
  spawnBehaviorEnemy,
  spawnEnemyProjectile,
  spawnAoeProjectile,
  spawnAreaAttack,
  spawnPlayer,
  clearEntityStores,
} from '../../src/core/helpers.js';
import { asFamilyId, initializeFactionRelations } from '../../src/core/faction-relations.js';
import { applyDamage } from '../../src/core/apply-damage.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { areaDamageSystem } from '../../src/core/systems/areaDamageSystem.js';
import {
  aoeOnImpactPreDamage,
  aoeOnImpactPostDamage,
} from '../../src/core/systems/aoeOnImpactSystem.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { familyFeudSystem, getFamilyAIDecision } from '../../src/game/systems/familyFeudSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

const families = [asFamilyId('a'), asFamilyId('b')];
function setup(relation = 45) {
  const world = createTestWorld({ floor: 2 });
  world.floorExtendedState = { familyState: { presentFamilies: families } as never };
  initializeFactionRelations(world, families);
  world.factionRelations.set(families[0]!, relation);
  const player = spawnPlayer(world, 0, 0);
  const mob = (family: number, x = 0) => {
    const eid = spawnBehaviorEnemy(world, x, 0, 100, 0, 0, 999, 0);
    addComponent(world.ecs, eid, set(FamilyMembership, { familyId: family, isBoss: 0 }));
    addComponent(world.ecs, eid, set(Damage, { amount: 5, cooldownMs: 0, lastFireMs: 0 }));
    addComponent(world.ecs, eid, set(Team, { id: 1 }));
    return eid;
  };
  return { world, player, mob };
}
const enemyDamage = {
  origin: 'enemy',
  affinity: 'unscaled',
  scaleWithPrimary: false,
  canCrit: false,
} as const;

describe('family combat authority', () => {
  it.each([0, 24, 25, 49, 50, 75, 76, 100])(
    'contact and direct damage respect relation %s',
    (relation) => {
      const { world, player, mob } = setup(relation);
      const source = mob(0);
      const before = world.stores.health.current[player]!;
      damageSystem(world, collisionSystem(world));
      expect(world.stores.health.current[player]).toBe(before - (relation < 50 ? 5 : 0));
      expect(
        world.combatEvents.filter((e) => e.type === 'hit' && e.targetEid === player),
      ).toHaveLength(relation < 50 ? 1 : 0);
      const dealt = applyDamage(world, player, 5, 0, 0, { ...enemyDamage, sourceEid: source });
      expect(dealt).toBe(relation < 50 ? 5 : 0);
    },
  );

  it('neutral contact cannot consume the player invulnerability window before a hostile hit', () => {
    const { world, player, mob } = setup(60);
    mob(0);
    mob(1);
    const before = world.stores.health.current[player]!;
    damageSystem(world, collisionSystem(world));
    expect(world.stores.health.current[player]).toBe(before - 5);
  });

  it.each([false, true])(
    'rival contacts damage exactly once while same-family contacts do not (rival=%s)',
    (rival) => {
      const { world, player, mob } = setup(60);
      world.stores.position.x[player] = 100;
      const a = mob(0),
        b = mob(rival ? 1 : 0);
      const collision = collisionSystem(world);
      damageSystem(world, collision);
      damageSystem(world, collision);
      expect(world.stores.health.current[a]).toBe(rival ? 95 : 100);
      expect(world.stores.health.current[b]).toBe(rival ? 95 : 100);
      world.elapsedMs += 250;
      damageSystem(world, collision);
      expect(world.stores.health.current[b]).toBe(rival ? 90 : 100);
    },
  );

  it.each([false, true])(
    'projectiles survive forbidden collisions and hit rivals (rival=%s)',
    (rival) => {
      const { world, player, mob } = setup(60);
      world.stores.position.x[player] = 100;
      const shooter = mob(0, 20),
        victim = mob(rival ? 1 : 0);
      const shot = spawnEnemyProjectile(world, 0, 0, 0, 0, 7, shooter);
      damageSystem(world, collisionSystem(world));
      expect(world.stores.health.current[victim]).toBe(rival ? 93 : 100);
      expect(hasComponent(world.ecs, shot, FamilyMembership)).toBe(!rival);
    },
  );

  it('a projectile retains neutral allegiance after its shooter is removed', () => {
    const { world, player, mob } = setup(60);
    const shooter = mob(0, 20);
    spawnEnemyProjectile(world, 0, 0, 0, 0, 7, shooter);
    clearEntityStores(world, shooter);
    removeEntity(world.ecs, shooter);
    const before = world.stores.health.current[player];
    damageSystem(world, collisionSystem(world));
    expect(world.stores.health.current[player]).toBe(before);
    expect(world.lastPlayerHit).toBeUndefined();
  });

  it.each([45, 60, 90])(
    'area attacks honor live relation %s and ignore same-family targets',
    (relation) => {
      const { world, player, mob } = setup(relation);
      const source = mob(0, 20),
        same = mob(0),
        rival = mob(1);
      const before = world.stores.health.current[player]!;
      spawnAreaAttack(world, 0, 0, source, 7, 2, 500, 1);
      const collision = collisionSystem(world);
      areaDamageSystem(world, collision);
      areaDamageSystem(world, collision);
      expect(world.stores.health.current[same]).toBe(100);
      expect(world.stores.health.current[rival]).toBe(93);
      expect(world.stores.health.current[player]).toBe(before - (relation < 50 ? 7 : 0));
      expect(
        world.combatEvents.filter((e) => e.type === 'hit' && e.targetEid === rival),
      ).toHaveLength(1);
    },
  );

  it('a projectile uses the current relation at impact without consuming forbidden pierce', () => {
    const { world, player, mob } = setup(90);
    const source = mob(0, 20);
    const shot = spawnEnemyProjectile(world, 0, 0, 0, 0, 7, source);
    const before = world.stores.health.current[player]!;
    damageSystem(world, collisionSystem(world));
    expect(world.stores.projectile.hitCount[shot]).toBe(0);
    world.factionRelations.set(families[0]!, 25);
    damageSystem(world, collisionSystem(world));
    expect(world.stores.health.current[player]).toBe(before - 7);
  });

  it('an explosion keeps shooter family identity after removal and processes each splash once', () => {
    const { world, player, mob } = setup(90);
    world.stores.position.x[player] = 100;
    const source = mob(0, 20),
      same = mob(0),
      rival = mob(1);
    world.stores.damage.amount[same] = 0;
    world.stores.damage.amount[rival] = 0;
    const shot = spawnAoeProjectile(world, 0, 0, 0, 0, 7, 2, 11, source, 1);
    addComponent(world.ecs, shot, EnemyProjectile);
    clearEntityStores(world, source);
    removeEntity(world.ecs, source);
    const collision = collisionSystem(world);
    aoeOnImpactPreDamage(world);
    damageSystem(world, collision);
    aoeOnImpactPostDamage(world);
    areaDamageSystem(world, collision);
    areaDamageSystem(world, collision);
    expect(world.stores.health.current[same]).toBe(100);
    expect(world.stores.health.current[rival]).toBe(82); // One direct hit + one splash.
    expect(
      world.combatEvents.filter((e) => e.type === 'hit' && e.targetEid === rival),
    ).toHaveLength(2);
    expect(world.lastFamilyHit.size).toBe(0); // No stale owner to retaliate against.
  });

  it('friendly defenders retain family attacker evidence after VFX drains the event queue', () => {
    const { world, player, mob } = setup(90);
    world.stores.position.x[player] = 100;
    const victim = mob(0),
      defender = mob(0, 5),
      attacker = mob(1, 20);
    applyDamage(world, victim, 5, 0, 0, { ...enemyDamage, sourceEid: attacker });
    world.combatEvents.length = 0;
    familyFeudSystem(world);
    expect(getFamilyAIDecision(world, defender)?.targetEid).toBe(attacker);
    expect(getFamilyAIDecision(world, defender)?.kind).toBe('attacker');
    world.elapsedMs += 100_000;
    familyFeudSystem(world);
    expect(getFamilyAIDecision(world, defender)?.kind).toBe('follow');
  });

  it('player defense rejects an attacker whose entity generation changed', () => {
    const { world, player, mob } = setup(90);
    const ally = mob(0, 5),
      attacker = mob(1, 20);
    applyDamage(world, player, 5, 0, 0, { ...enemyDamage, sourceEid: attacker });
    world.combatEvents.length = 0;
    familyFeudSystem(world);
    expect(getFamilyAIDecision(world, ally)?.targetEid).toBe(attacker);
    // Recycling can retain the same eid and components but never the generation.
    world.entityRenderGeneration[attacker] = world.entityRenderGeneration[attacker]! + 1;
    familyFeudSystem(world);
    expect(getFamilyAIDecision(world, ally)?.kind).not.toBe('attacker');
  });

  it('a lethal feud contact emits one death and cannot hit again as a corpse', () => {
    const { world, player, mob } = setup(60);
    world.stores.position.x[player] = 100;
    const a = mob(0),
      b = mob(1);
    world.stores.health.current[b] = 5;
    damageSystem(world, collisionSystem(world));
    dropSystem(world);
    dropSystem(world);
    expect(hasComponent(world.ecs, b, DeathTimer)).toBe(true);
    expect(world.combatEvents.filter((e) => e.type === 'death' && e.targetEid === b)).toHaveLength(
      1,
    );
    const health = world.stores.health.current[a];
    world.elapsedMs += 250;
    damageSystem(world, collisionSystem(world));
    expect(world.stores.health.current[a]).toBe(health);
    expect(world.factionRelationDeltas).toHaveLength(0);
  });
});
