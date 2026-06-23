import { addComponent, entityExists, hasComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Enemy,
  Health,
  Knockback,
  MeleeSwing,
  Owner,
  Player,
  Position,
  Projectile,
  Returning,
  Team,
  Velocity,
} from '../../src/core/components.js';
import { createEntity } from '../../src/core/helpers.js';
import { clearMeleeSwingHits, meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import { returningProjectileSystem } from '../../src/core/systems/returningProjectileSystem.js';
import { MeleeStyle } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

function createSlashSwing(world: ReturnType<typeof createTestWorld>, x: number, y: number): number {
  const swing = createEntity(world);
  addComponent(world.ecs, swing, set(Position, { x, y }));
  addComponent(
    world.ecs,
    swing,
    set(MeleeSwing, {
      bladeLength: 32,
      arcCenterRad: 0,
      arcHalfRad: 0,
      damage: 10,
      spawnAtMs: 0,
      durationMs: 1000,
      style: MeleeStyle.SLASH,
      headRadius: 0,
      shaftDamageMult: 1,
      knockback: 0,
    }),
  );
  return swing;
}

describe('meleeSwingSystem coverage edges', () => {
  it('can hit again after clearMeleeSwingHits removes tracked targets', () => {
    const world = createTestWorld();
    const swing = createSlashSwing(world, 100, 100);
    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 120, y: 100 }));
    addComponent(world.ecs, enemy, set(Health, { current: 100, max: 100 }));
    addComponent(world.ecs, enemy, Enemy);

    meleeSwingSystem(world);
    expect(world.stores.health.current[enemy]).toBe(90);

    meleeSwingSystem(world);
    expect(world.stores.health.current[enemy]).toBe(90);

    clearMeleeSwingHits(world, swing);
    meleeSwingSystem(world);
    expect(world.stores.health.current[enemy]).toBe(80);
  });

  it('handles zero-length blade segment via shaft distance fallback', () => {
    const world = createTestWorld();
    const swing = createEntity(world);
    addComponent(world.ecs, swing, set(Position, { x: 50, y: 50 }));
    addComponent(
      world.ecs,
      swing,
      set(MeleeSwing, {
        bladeLength: 0,
        arcCenterRad: 0,
        arcHalfRad: 0,
        damage: 7,
        spawnAtMs: 0,
        durationMs: 1000,
        style: MeleeStyle.SLASH,
        headRadius: 0,
        shaftDamageMult: 1,
        knockback: 0,
      }),
    );

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 50, y: 50 }));
    addComponent(world.ecs, enemy, set(Health, { current: 20, max: 20 }));
    addComponent(world.ecs, enemy, Enemy);

    meleeSwingSystem(world);
    expect(world.stores.health.current[enemy]).toBe(13);
  });

  it('ignores entities that have Health+Position but are neither Enemy nor Player', () => {
    const world = createTestWorld();
    createSlashSwing(world, 100, 100);

    const neutral = createEntity(world);
    addComponent(world.ecs, neutral, set(Position, { x: 120, y: 100 }));
    addComponent(world.ecs, neutral, set(Health, { current: 40, max: 40 }));

    meleeSwingSystem(world);
    expect(world.stores.health.current[neutral]).toBe(40);
  });

  it('skips same-team targets', () => {
    const world = createTestWorld();
    const swing = createSlashSwing(world, 100, 100);
    addComponent(world.ecs, swing, set(Team, { id: 1 }));

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 120, y: 100 }));
    addComponent(world.ecs, enemy, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, enemy, Enemy);
    addComponent(world.ecs, enemy, set(Team, { id: 1 }));

    meleeSwingSystem(world);
    expect(world.stores.health.current[enemy]).toBe(50);
  });

  it('updates existing Knockback via setComponent when target already has Knockback', () => {
    const world = createTestWorld();
    const swing = createEntity(world);
    addComponent(world.ecs, swing, set(Position, { x: 100, y: 100 }));
    addComponent(
      world.ecs,
      swing,
      set(MeleeSwing, {
        bladeLength: 48,
        arcCenterRad: 0,
        arcHalfRad: 0,
        damage: 10,
        spawnAtMs: 0,
        durationMs: 1000,
        style: MeleeStyle.SLASH,
        headRadius: 12,
        shaftDamageMult: 1,
        knockback: 30,
      }),
    );

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 148, y: 100 }));
    addComponent(world.ecs, enemy, set(Health, { current: 100, max: 100 }));
    addComponent(world.ecs, enemy, Enemy);
    addComponent(
      world.ecs,
      enemy,
      set(Knockback, {
        dirX: 0,
        dirY: 0,
        remaining: 1,
        speed: 1,
      }),
    );

    meleeSwingSystem(world);

    expect(world.stores.health.current[enemy]).toBe(90);
    expect(hasComponent(world.ecs, enemy, Knockback)).toBe(true);
    expect(world.stores.knockback.remaining[enemy]).toBe(30);
    expect(world.stores.knockback.speed[enemy]).toBe(3);
    expect(world.stores.knockback.dirX[enemy]).toBeCloseTo(1, 6);
    expect(world.stores.knockback.dirY[enemy]).toBeCloseTo(0, 6);
  });

  it('does not apply knockback when target overlaps swing origin (zero knockback direction)', () => {
    const world = createTestWorld();
    const swing = createEntity(world);
    addComponent(world.ecs, swing, set(Position, { x: 100, y: 100 }));
    addComponent(
      world.ecs,
      swing,
      set(MeleeSwing, {
        bladeLength: 0,
        arcCenterRad: 0,
        arcHalfRad: 0,
        damage: 10,
        spawnAtMs: 0,
        durationMs: 1000,
        style: MeleeStyle.SLASH,
        headRadius: 20,
        shaftDamageMult: 1,
        knockback: 40,
      }),
    );

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 100, y: 100 }));
    addComponent(world.ecs, enemy, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, enemy, Enemy);

    meleeSwingSystem(world);

    expect(world.stores.health.current[enemy]).toBe(40);
    expect(hasComponent(world.ecs, enemy, Knockback)).toBe(false);
  });

  it('does not damage the owner even when owner is in the Health query', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: 100, y: 100 }));
    addComponent(world.ecs, owner, set(Health, { current: 100, max: 100 }));
    addComponent(world.ecs, owner, Player);

    const swing = createSlashSwing(world, 100, 100);
    addComponent(world.ecs, swing, set(Owner, { eid: owner }));

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 120, y: 100 }));
    addComponent(world.ecs, enemy, set(Health, { current: 100, max: 100 }));
    addComponent(world.ecs, enemy, Enemy);

    meleeSwingSystem(world);

    expect(world.stores.health.current[owner]).toBe(100);
    expect(world.stores.health.current[enemy]).toBe(90);
  });

  it('keeps swing position when owner exists but has no Position component', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, Player);

    const swing = createSlashSwing(world, 100, 100);
    addComponent(world.ecs, swing, set(Owner, { eid: owner }));

    meleeSwingSystem(world);

    expect(world.stores.position.x[swing]).toBe(12.5);
    expect(world.stores.position.y[swing]).toBe(12.5);
  });
});

describe('returningProjectileSystem coverage edges', () => {
  it('despawns returning projectile when owner entity is missing', () => {
    const world = createTestWorld();
    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, { isReturning: 1, returnSpeed: 10, maxRange: 100 }),
    );
    addComponent(world.ecs, projectile, set(Owner, { eid: 999 }));

    returningProjectileSystem(world);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('despawns returning projectile when owner has no Position component', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, Player);

    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, { isReturning: 1, returnSpeed: 10, maxRange: 100 }),
    );
    addComponent(world.ecs, projectile, set(Owner, { eid: owner }));

    returningProjectileSystem(world);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('switches to returning without projectile component after exceeding range', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: 0, y: 0 }));

    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 30, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 0,
        returnSpeed: 12,
        maxRange: 10,
        originX: 0,
        originY: 0,
      }),
    );
    addComponent(world.ecs, projectile, set(Owner, { eid: owner }));

    returningProjectileSystem(world);

    expect(world.stores.returning.isReturning[projectile]).toBe(1);
    expect(entityExists(world.ecs, projectile)).toBe(true);
  });

  it('restores inbound infinite pierce and clears hit count when turning back', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: 0, y: 0 }));

    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 30, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 0,
        returnSpeed: 12,
        maxRange: 10,
        originX: 0,
        originY: 0,
      }),
    );
    addComponent(world.ecs, projectile, set(Owner, { eid: owner }));
    addComponent(world.ecs, projectile, set(Projectile, { pierce: 0, hitCount: 7 }));

    returningProjectileSystem(world);

    expect(world.stores.returning.isReturning[projectile]).toBe(1);
    expect(world.stores.projectile.pierce[projectile]).toBe(255);
    expect(world.stores.projectile.hitCount[projectile]).toBe(0);
  });

  it('steers velocity toward owner while returning', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: 100, y: 0 }));

    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 1,
        returnSpeed: 20,
        maxRange: 100,
        originX: 0,
        originY: 0,
      }),
    );
    addComponent(world.ecs, projectile, set(Owner, { eid: owner }));

    returningProjectileSystem(world);

    expect(world.stores.velocity.x[projectile]).toBeCloseTo(20, 6);
    expect(world.stores.velocity.y[projectile]).toBeCloseTo(0, 6);
  });

  it('removes projectile when it reaches pickup radius while returning', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: 8, y: 0 }));

    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 1,
        returnSpeed: 20,
        maxRange: 100,
        originX: 0,
        originY: 0,
      }),
    );
    addComponent(world.ecs, projectile, set(Owner, { eid: owner }));

    returningProjectileSystem(world);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('does not switch to returning before max range is reached', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: 0, y: 0 }));

    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 9, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 0,
        returnSpeed: 12,
        maxRange: 10,
        originX: 0,
        originY: 0,
      }),
    );
    addComponent(world.ecs, projectile, set(Owner, { eid: owner }));

    returningProjectileSystem(world);
    expect(world.stores.returning.isReturning[projectile]).toBe(0);
    expect(entityExists(world.ecs, projectile)).toBe(true);
  });

  it('despawns returning projectile without Owner component', () => {
    const world = createTestWorld();
    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, { isReturning: 1, returnSpeed: 10, maxRange: 100 }),
    );

    returningProjectileSystem(world);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });
});
