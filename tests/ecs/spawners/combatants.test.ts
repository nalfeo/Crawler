import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Damage,
  Enemy,
  EnemyBehavior,
  Flying,
  Health,
  Player,
  Position,
  Spawner,
  Sprite,
  Velocity,
} from '../../../src/core/components.js';
import {
  spawnBehaviorEnemy,
  spawnEnemy,
  spawnPlayer,
  spawnSpawner,
} from '../../../src/core/spawners/combatants.js';
import { TRAVERSAL_MODE } from '../../../src/shared/enemy-behavior.js';
import { createTestWorld } from '../../helpers/world-factory.js';

describe('spawnPlayer', () => {
  it('creates a player with all expected components and an inventory bag', () => {
    const world = createTestWorld();
    const eid = spawnPlayer(world, 1.5, 4.25);

    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, Velocity)).toBe(true);
    expect(hasComponent(world.ecs, eid, Health)).toBe(true);
    expect(hasComponent(world.ecs, eid, Player)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.position.x[eid]).toBe(1.5);
    expect(world.stores.position.y[eid]).toBe(4.25);
    expect(world.stores.health.current[eid]).toBe(100);
    expect(world.stores.health.max[eid]).toBe(100);
    expect(world.stores.sprite.width[eid]).toBe(3);
    expect(world.stores.sprite.height[eid]).toBe(3);
    expect(world.stores.weight.value[eid]).toBe(180);
    expect(world.inventories.has(eid)).toBe(true);
  });

  it('honors a custom weight', () => {
    const world = createTestWorld();
    const eid = spawnPlayer(world, 0, 0, 210);
    expect(world.stores.weight.value[eid]).toBe(210);
  });
});

describe('spawnEnemy', () => {
  it('creates an enemy with default red blood', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, -2.5, 5.625, 60);
    const sizeScale = world.stores.sprite.sizeScale[eid]!;

    expect(hasComponent(world.ecs, eid, Enemy)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.health.current[eid]).toBe(60);
    expect(world.stores.health.max[eid]).toBe(60);
    expect(world.stores.sprite.width[eid]).toBe(2);
    expect(sizeScale).toBeGreaterThanOrEqual(0.9);
    expect(sizeScale).toBeLessThanOrEqual(1.1);
    expect(world.stores.sprite.variantRoll[eid]).toBeGreaterThanOrEqual(0);
    expect(world.stores.sprite.variantRoll[eid]!).toBeLessThan(1);
    // Slice 2 (ADR 0044): weight is a first-class gameplay dial, no longer
    // jittered by sizeScale. spawnEnemy defaults to 120 lb.
    expect(world.stores.weight.value[eid]).toBe(120);
    expect(world.stores.bloodColor.r[eid]).toBe(0xcc);
    expect(world.stores.bloodColor.g[eid]).toBe(0);
    expect(world.stores.bloodColor.b[eid]).toBe(0);
  });

  it('honors a custom blood color', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10, 100, 0x00ff11);
    expect(world.stores.bloodColor.r[eid]).toBe(0);
    expect(world.stores.bloodColor.g[eid]).toBe(0xff);
    expect(world.stores.bloodColor.b[eid]).toBe(0x11);
  });
});

describe('spawnBehaviorEnemy', () => {
  it('stores behavior data and defaults', () => {
    const world = createTestWorld();
    const eid = spawnBehaviorEnemy(world, 3.75, -1.25, 45, 2, 1.5, 220, 160);
    const sizeScale = world.stores.sprite.sizeScale[eid]!;

    expect(hasComponent(world.ecs, eid, Enemy)).toBe(true);
    expect(hasComponent(world.ecs, eid, EnemyBehavior)).toBe(true);
    expect(hasComponent(world.ecs, eid, Flying)).toBe(false);
    expect(world.stores.enemyBehavior.type[eid]).toBe(2);
    expect(world.stores.enemyBehavior.speed[eid]).toBeCloseTo(1.5);
    expect(world.stores.enemyBehavior.aggroRange[eid]).toBe(220);
    expect(world.stores.enemyBehavior.attackRange[eid]).toBe(160);
    expect(world.stores.enemyBehavior.flankDistance[eid]).toBe(12);
    expect(world.stores.enemyBehavior.pathRefreshFrames[eid]).toBe(10);
    expect(sizeScale).toBeGreaterThanOrEqual(0.9);
    expect(sizeScale).toBeLessThanOrEqual(1.1);
    // Slice 2 (ADR 0044): weight is a first-class gameplay dial, no longer
    // jittered by sizeScale. spawnBehaviorEnemy defaults to 120 lb.
    expect(world.stores.weight.value[eid]).toBe(120);
  });

  it('adds the Flying tag for flying traversal and applies option overrides', () => {
    const world = createTestWorld();
    const eid = spawnBehaviorEnemy(world, 0, 0, 30, 1, 2, 100, 50, {
      traversalMode: TRAVERSAL_MODE.FLYING,
      flankDistance: 7,
      pathRefreshFrames: 4,
      weight: 90,
    });

    expect(hasComponent(world.ecs, eid, Flying)).toBe(true);
    expect(world.stores.enemyBehavior.traversalMode[eid]).toBe(TRAVERSAL_MODE.FLYING);
    expect(world.stores.enemyBehavior.flankDistance[eid]).toBe(7);
    expect(world.stores.enemyBehavior.pathRefreshFrames[eid]).toBe(4);
    // Slice 2 (ADR 0044): weight is passed through unmodified — no sizeScale mult.
    expect(world.stores.weight.value[eid]).toBe(90);
  });

  it('adds Flying when isFlying is set even on ground traversal', () => {
    const world = createTestWorld();
    const eid = spawnBehaviorEnemy(world, 0, 0, 30, 1, 2, 100, 50, { isFlying: true });
    expect(hasComponent(world.ecs, eid, Flying)).toBe(true);
  });
});

describe('spawnSpawner', () => {
  it('creates an immobile spawner structure without Velocity or EnemyBehavior', () => {
    const world = createTestWorld();
    const eid = spawnSpawner(world, 4, 8, 300, { defIndex: 2 });

    expect(hasComponent(world.ecs, eid, Enemy)).toBe(true);
    expect(hasComponent(world.ecs, eid, Spawner)).toBe(true);
    expect(hasComponent(world.ecs, eid, Velocity)).toBe(false);
    expect(hasComponent(world.ecs, eid, EnemyBehavior)).toBe(false);
    expect(hasComponent(world.ecs, eid, Damage)).toBe(false);
    expect(world.stores.health.current[eid]).toBe(300);
    expect(world.stores.spawner.defIndex[eid]).toBe(2);
    expect(world.stores.spawner.mode[eid]).toBe(0);
    expect(world.stores.spawner.nextSpawnMs[eid]).toBe(world.elapsedMs);
    expect(world.stores.weight.value[eid]).toBe(200);
    expect(world.stores.sprite.width[eid]).toBe(3);
  });

  it('floors/clamps defIndex, applies initial delay, and adds contact Damage', () => {
    const world = createTestWorld();
    const eid = spawnSpawner(world, 0, 0, 100, {
      defIndex: 3.9,
      contactDamage: 7,
      initialDelayMs: 500,
      weight: 250,
      textureId: 4,
      spriteWidth: 5,
      spriteHeight: 6,
    });

    expect(world.stores.spawner.defIndex[eid]).toBe(3);
    expect(world.stores.spawner.nextSpawnMs[eid]).toBe(world.elapsedMs + 500);
    expect(hasComponent(world.ecs, eid, Damage)).toBe(true);
    expect(world.stores.damage.amount[eid]).toBe(7);
    expect(world.stores.weight.value[eid]).toBe(250);
    expect(world.stores.sprite.textureId[eid]).toBe(4);
    expect(world.stores.sprite.width[eid]).toBe(5);
    expect(world.stores.sprite.height[eid]).toBe(6);
  });
});
