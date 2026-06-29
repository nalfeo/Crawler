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
import {
  clearMeleeSwingHits,
  markImmuneToActiveMeleeSwings,
  meleeSwingSystem,
} from '../../src/core/systems/meleeSwingSystem.js';
import { returningProjectileSystem } from '../../src/core/systems/returningProjectileSystem.js';
import { MeleeStyle } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeOpenFloorMap } from '../helpers/map-fixtures.js';

function createSlashSwing(world: ReturnType<typeof createTestWorld>, x: number, y: number): number {
  const swing = createEntity(world);
  addComponent(world.ecs, swing, set(Position, { x, y }));
  addComponent(
    world.ecs,
    swing,
    set(MeleeSwing, {
      bladeLength: 4,
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
    const swing = createSlashSwing(world, 12.5, 12.5);
    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 15, y: 12.5 }));
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

  it('markImmuneToActiveMeleeSwings makes an active swing skip a target until it is replaced', () => {
    const world = createTestWorld();
    const swing = createSlashSwing(world, 12.5, 12.5);
    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 15, y: 12.5 }));
    addComponent(world.ecs, enemy, set(Health, { current: 100, max: 100 }));
    addComponent(world.ecs, enemy, Enemy);

    // Register the target in the active swing's hit set before it processes — as a
    // freshly-split baby slime is the frame its parent dies mid-swing. The
    // in-progress swing must now pass right through it.
    markImmuneToActiveMeleeSwings(world, enemy);
    meleeSwingSystem(world);
    expect(world.stores.health.current[enemy]).toBe(100);

    // The player swings again: a fresh swing (empty hit set) connects normally.
    clearMeleeSwingHits(world, swing);
    meleeSwingSystem(world);
    expect(world.stores.health.current[enemy]).toBe(90);
  });

  it('handles zero-length blade segment via shaft distance fallback', () => {
    const world = createTestWorld();
    const swing = createEntity(world);
    addComponent(world.ecs, swing, set(Position, { x: 6.25, y: 6.25 }));
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
    addComponent(world.ecs, enemy, set(Position, { x: 6.25, y: 6.25 }));
    addComponent(world.ecs, enemy, set(Health, { current: 20, max: 20 }));
    addComponent(world.ecs, enemy, Enemy);

    meleeSwingSystem(world);
    expect(world.stores.health.current[enemy]).toBe(13);
  });

  it('ignores entities that have Health+Position but are neither Enemy nor Player', () => {
    const world = createTestWorld();
    createSlashSwing(world, 12.5, 12.5);

    const neutral = createEntity(world);
    addComponent(world.ecs, neutral, set(Position, { x: 15, y: 12.5 }));
    addComponent(world.ecs, neutral, set(Health, { current: 40, max: 40 }));

    meleeSwingSystem(world);
    expect(world.stores.health.current[neutral]).toBe(40);
  });

  it('skips same-team targets', () => {
    const world = createTestWorld();
    const swing = createSlashSwing(world, 12.5, 12.5);
    addComponent(world.ecs, swing, set(Team, { id: 1 }));

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 15, y: 12.5 }));
    addComponent(world.ecs, enemy, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, enemy, Enemy);
    addComponent(world.ecs, enemy, set(Team, { id: 1 }));

    meleeSwingSystem(world);
    expect(world.stores.health.current[enemy]).toBe(50);
  });

  it('updates existing Knockback via setComponent when target already has Knockback', () => {
    const world = createTestWorld();
    const swing = createEntity(world);
    addComponent(world.ecs, swing, set(Position, { x: 12.5, y: 12.5 }));
    addComponent(
      world.ecs,
      swing,
      set(MeleeSwing, {
        bladeLength: 6,
        arcCenterRad: 0,
        arcHalfRad: 0,
        damage: 10,
        spawnAtMs: 0,
        durationMs: 1000,
        style: MeleeStyle.SLASH,
        headRadius: 1.5,
        shaftDamageMult: 1,
        knockback: 3.75,
      }),
    );

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 18.5, y: 12.5 }));
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
    expect(world.stores.knockback.remaining[enemy]).toBe(3.75);
    expect(world.stores.knockback.speed[enemy]).toBe(0.375);
    expect(world.stores.knockback.dirX[enemy]).toBeCloseTo(1, 6);
    expect(world.stores.knockback.dirY[enemy]).toBeCloseTo(0, 6);
  });

  it('does not apply knockback when target overlaps swing origin (zero knockback direction)', () => {
    const world = createTestWorld();
    const swing = createEntity(world);
    addComponent(world.ecs, swing, set(Position, { x: 12.5, y: 12.5 }));
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
        headRadius: 2.5,
        shaftDamageMult: 1,
        knockback: 5,
      }),
    );

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 12.5, y: 12.5 }));
    addComponent(world.ecs, enemy, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, enemy, Enemy);

    meleeSwingSystem(world);

    expect(world.stores.health.current[enemy]).toBe(40);
    expect(hasComponent(world.ecs, enemy, Knockback)).toBe(false);
  });

  it('does not damage the owner even when owner is in the Health query', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: 12.5, y: 12.5 }));
    addComponent(world.ecs, owner, set(Health, { current: 100, max: 100 }));
    addComponent(world.ecs, owner, Player);

    const swing = createSlashSwing(world, 12.5, 12.5);
    addComponent(world.ecs, swing, set(Owner, { eid: owner }));

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: 15, y: 12.5 }));
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

    const swing = createSlashSwing(world, 12.5, 12.5);
    addComponent(world.ecs, swing, set(Owner, { eid: owner }));

    meleeSwingSystem(world);

    expect(world.stores.position.x[swing]).toBe(12.5);
    expect(world.stores.position.y[swing]).toBe(12.5);
  });
});

describe('meleeSwingSystem line-of-sight gating', () => {
  const TILE = 4; // feet per tile (matches FloorMap.tileToWorld)
  const cx = (tx: number): number => tx * TILE + TILE / 2;
  const cy = (ty: number): number => ty * TILE + TILE / 2;

  // A zero-arc SLASH that points straight along +x, so its blade segment sweeps
  // a horizontal line from the owner across several tiles regardless of progress.
  function spawnStraightSwing(
    world: ReturnType<typeof createTestWorld>,
    owner: number,
    ox: number,
    oy: number,
  ): number {
    const swing = createEntity(world);
    addComponent(world.ecs, swing, set(Position, { x: ox, y: oy }));
    addComponent(world.ecs, swing, set(Owner, { eid: owner }));
    addComponent(
      world.ecs,
      swing,
      set(MeleeSwing, {
        bladeLength: 40,
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

  it('does not damage an enemy on the far side of a wall', () => {
    const world = createTestWorld();
    world.floorMap = makeOpenFloorMap(4); // wall column at tile x=4
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: cx(2), y: cy(5) }));
    addComponent(world.ecs, owner, Player);
    spawnStraightSwing(world, owner, cx(2), cy(5));

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: cx(6), y: cy(5) }));
    addComponent(world.ecs, enemy, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, enemy, Enemy);

    meleeSwingSystem(world);

    // The blade geometrically sweeps over the enemy, but the wall blocks the hit.
    expect(world.stores.health.current[enemy]).toBe(50);
  });

  it('damages an enemy with a clear line of sight', () => {
    const world = createTestWorld();
    world.floorMap = makeOpenFloorMap(); // no wall
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: cx(2), y: cy(5) }));
    addComponent(world.ecs, owner, Player);
    spawnStraightSwing(world, owner, cx(2), cy(5));

    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Position, { x: cx(6), y: cy(5) }));
    addComponent(world.ecs, enemy, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, enemy, Enemy);

    meleeSwingSystem(world);

    expect(world.stores.health.current[enemy]).toBe(40);
  });

  it('blocks an enemy swing from striking the player through a wall', () => {
    const world = createTestWorld();
    world.floorMap = makeOpenFloorMap(4);
    const enemyOwner = createEntity(world);
    addComponent(world.ecs, enemyOwner, set(Position, { x: cx(2), y: cy(5) }));
    addComponent(world.ecs, enemyOwner, Enemy);
    spawnStraightSwing(world, enemyOwner, cx(2), cy(5));

    const player = createEntity(world);
    addComponent(world.ecs, player, set(Position, { x: cx(6), y: cy(5) }));
    addComponent(world.ecs, player, set(Health, { current: 80, max: 80 }));
    addComponent(world.ecs, player, Player);

    meleeSwingSystem(world);

    expect(world.stores.health.current[player]).toBe(80);
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
      set(Returning, { isReturning: 1, returnSpeed: 1.25, maxRange: 12.5 }),
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
      set(Returning, { isReturning: 1, returnSpeed: 1.25, maxRange: 12.5 }),
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
    addComponent(world.ecs, projectile, set(Position, { x: 3.75, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 0,
        returnSpeed: 1.5,
        maxRange: 1.25,
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
    addComponent(world.ecs, projectile, set(Position, { x: 3.75, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 0,
        returnSpeed: 1.5,
        maxRange: 1.25,
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
    addComponent(world.ecs, owner, set(Position, { x: 12.5, y: 0 }));

    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 1,
        returnSpeed: 2.5,
        maxRange: 12.5,
        originX: 0,
        originY: 0,
      }),
    );
    addComponent(world.ecs, projectile, set(Owner, { eid: owner }));

    returningProjectileSystem(world);

    expect(world.stores.velocity.x[projectile]).toBeCloseTo(2.5, 6);
    expect(world.stores.velocity.y[projectile]).toBeCloseTo(0, 6);
  });

  it('removes projectile when it reaches pickup radius while returning', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    addComponent(world.ecs, owner, set(Position, { x: 1, y: 0 }));

    const projectile = createEntity(world);
    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 1,
        returnSpeed: 2.5,
        maxRange: 12.5,
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
    addComponent(world.ecs, projectile, set(Position, { x: 1.125, y: 0 }));
    addComponent(world.ecs, projectile, set(Velocity, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      projectile,
      set(Returning, {
        isReturning: 0,
        returnSpeed: 1.5,
        maxRange: 1.25,
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
      set(Returning, { isReturning: 1, returnSpeed: 1.25, maxRange: 12.5 }),
    );

    returningProjectileSystem(world);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });
});
