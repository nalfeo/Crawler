import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  AoeOnImpact,
  Bouncing,
  Damage,
  EnemyProjectile,
  Lifetime,
  LineDamage,
  Owner,
  Position,
  Projectile,
  Returning,
  Team,
  Velocity,
} from '../../../src/core/components.js';
import {
  spawnAoeProjectile,
  spawnBeam,
  spawnBouncingProjectile,
  spawnEnemyProjectile,
  spawnProjectile,
  spawnReturningProjectile,
} from '../../../src/core/spawners/projectiles.js';
import { createTestWorld } from '../../helpers/world-factory.js';

describe('spawnProjectile', () => {
  it('creates a moving, damaging projectile with origin tracking', () => {
    const world = createTestWorld();
    const eid = spawnProjectile(world, 1.25, 2.5, 0.375, -0.5, 12, 2, 40);

    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, Velocity)).toBe(true);
    expect(hasComponent(world.ecs, eid, Damage)).toBe(true);
    expect(hasComponent(world.ecs, eid, Projectile)).toBe(true);
    expect(hasComponent(world.ecs, eid, Owner)).toBe(false);
    expect(world.stores.velocity.x[eid]).toBe(0.375);
    expect(world.stores.damage.amount[eid]).toBe(12);
    expect(world.stores.projectile.pierce[eid]).toBe(2);
    expect(world.stores.projectile.maxRange[eid]).toBe(40);
    expect(world.stores.projectile.originX[eid]).toBe(1.25);
    expect(world.stores.projectile.originY[eid]).toBe(2.5);
    expect(world.stores.sprite.width[eid]).toBe(0.75);
  });

  it('attaches an Owner when ownerEid is provided', () => {
    const world = createTestWorld();
    const eid = spawnProjectile(world, 0, 0, 1, 0, 5, 0, 0, 1, 42);
    expect(hasComponent(world.ecs, eid, Owner)).toBe(true);
    expect(world.stores.owner.eid[eid]).toBe(42);
  });
});

describe('spawnEnemyProjectile', () => {
  it('is a base projectile tagged with EnemyProjectile', () => {
    const world = createTestWorld();
    const eid = spawnEnemyProjectile(world, 0, 0, -1, 0, 8);

    expect(hasComponent(world.ecs, eid, Projectile)).toBe(true);
    expect(hasComponent(world.ecs, eid, EnemyProjectile)).toBe(true);
    expect(world.stores.damage.amount[eid]).toBe(8);
  });
});

describe('spawnAoeProjectile', () => {
  it('carries AoeOnImpact payload plus Owner and Team', () => {
    const world = createTestWorld();
    const eid = spawnAoeProjectile(world, 0, 0, 1, 0, 10, 5, 25, 3, 1, 60);

    expect(hasComponent(world.ecs, eid, AoeOnImpact)).toBe(true);
    expect(world.stores.aoeOnImpact.radius[eid]).toBe(5);
    expect(world.stores.aoeOnImpact.damage[eid]).toBe(25);
    expect(world.stores.projectile.maxRange[eid]).toBe(60);
    expect(world.stores.owner.eid[eid]).toBe(3);
    expect(world.stores.team.id[eid]).toBe(1);
  });
});

describe('spawnReturningProjectile', () => {
  it('stores Returning origin/return data plus pierce, Owner and Team', () => {
    const world = createTestWorld();
    const eid = spawnReturningProjectile(world, 2, 4, 1, 0, 9, 6, 0.5, 80, 2, 3);

    expect(hasComponent(world.ecs, eid, Returning)).toBe(true);
    expect(world.stores.returning.returnSpeed[eid]).toBe(0.5);
    expect(world.stores.returning.isReturning[eid]).toBe(0);
    expect(world.stores.returning.maxRange[eid]).toBe(80);
    expect(world.stores.returning.originX[eid]).toBe(2);
    expect(world.stores.returning.originY[eid]).toBe(4);
    expect(world.stores.projectile.pierce[eid]).toBe(3);
    expect(world.stores.owner.eid[eid]).toBe(6);
    expect(world.stores.team.id[eid]).toBe(2);
  });
});

describe('spawnBouncingProjectile', () => {
  it('tracks remaining bounces and forwards owner', () => {
    const world = createTestWorld();
    const eid = spawnBouncingProjectile(world, 0, 0, 1, 1, 4, 3, 1, 50, 9);

    expect(hasComponent(world.ecs, eid, Bouncing)).toBe(true);
    expect(world.stores.bouncing.remainingBounces[eid]).toBe(3);
    expect(world.stores.projectile.pierce[eid]).toBe(1);
    expect(world.stores.projectile.maxRange[eid]).toBe(50);
    expect(world.stores.weight.value[eid]).toBe(1);
    expect(world.stores.owner.eid[eid]).toBe(9);
  });
});

describe('spawnBeam', () => {
  it('creates a line-damage beam with lifetime and back-dated tick', () => {
    const world = createTestWorld();
    const eid = spawnBeam(world, 1, 2, 1, 0, 20, 6, 800, 100, 5, 1);

    expect(hasComponent(world.ecs, eid, LineDamage)).toBe(true);
    expect(hasComponent(world.ecs, eid, Lifetime)).toBe(true);
    expect(hasComponent(world.ecs, eid, Owner)).toBe(true);
    expect(hasComponent(world.ecs, eid, Team)).toBe(true);
    expect(world.stores.lineDamage.dirX[eid]).toBe(1);
    expect(world.stores.lineDamage.length[eid]).toBe(20);
    expect(world.stores.lineDamage.damage[eid]).toBe(6);
    expect(world.stores.lineDamage.tickMs[eid]).toBe(100);
    // Back-dated by one tick so the beam deals damage immediately.
    expect(world.stores.lineDamage.lastTickMs[eid]).toBe(world.elapsedMs - 100);
    expect(world.stores.lifetime.expiresAtMs[eid]).toBe(world.elapsedMs + 800);
    expect(world.stores.sprite.width[eid]).toBe(20);
    expect(world.stores.sprite.height[eid]).toBe(0.5);
  });
});
