import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Glowing, Homing, Position, Velocity } from '../../src/core/components.js';
import { createEntity, spawnEnemy } from '../../src/core/helpers.js';
import { homingSystem } from '../../src/core/systems/homingSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

function spawnHomingBolt(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
  vx: number,
  vy: number,
  targetEid: number,
  options: { activateFrame?: number; turnRateRadPerFrame?: number } = {},
): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: vx, y: vy }));
  addComponent(
    world.ecs,
    eid,
    set(Homing, {
      targetEid,
      speed: Math.hypot(vx, vy),
      turnRateRadPerFrame: options.turnRateRadPerFrame ?? 0.2,
      activateFrame: options.activateFrame ?? 0,
    }),
  );
  return eid;
}

describe('homingSystem', () => {
  it('keeps flying its launch heading during the arc-out delay', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 100, 0, 50);
    // Launched straight up (0, -1) while the target is due east — a homing
    // missile must NOT start curving before its activateFrame.
    const bolt = spawnHomingBolt(world, 0, 0, 0, -1, target, { activateFrame: 10 });

    world.frameCount = 5;
    homingSystem(world);

    expect(world.stores.velocity.x[bolt]).toBeCloseTo(0);
    expect(world.stores.velocity.y[bolt]).toBeCloseTo(-1);
  });

  it('curves toward the live target heading once active, without exceeding the turn rate', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 0, 100, 50);
    // Launched due east (1, 0); target is due south, a 90-degree turn.
    const bolt = spawnHomingBolt(world, 0, 0, 1, 0, target, {
      activateFrame: 0,
      turnRateRadPerFrame: 0.3,
    });

    world.frameCount = 0;
    homingSystem(world);

    const angle = Math.atan2(
      world.stores.velocity.y[bolt] ?? 0,
      world.stores.velocity.x[bolt] ?? 0,
    );
    expect(angle).toBeCloseTo(0.3, 5);
    // Speed is preserved — this is a pure rotation, not an acceleration.
    const speed = Math.hypot(
      world.stores.velocity.x[bolt] ?? 0,
      world.stores.velocity.y[bolt] ?? 0,
    );
    expect(speed).toBeCloseTo(1, 5);
  });

  it('eventually aligns fully onto a stationary target after enough active frames', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 0, 100, 50);
    const bolt = spawnHomingBolt(world, 0, 0, 1, 0, target, {
      activateFrame: 0,
      turnRateRadPerFrame: 0.3,
    });

    for (let frame = 0; frame < 10; frame += 1) {
      world.frameCount = frame;
      homingSystem(world);
    }

    const angle = Math.atan2(
      world.stores.velocity.y[bolt] ?? 0,
      world.stores.velocity.x[bolt] ?? 0,
    );
    expect(angle).toBeCloseTo(Math.PI / 2, 2);
  });

  it('keeps its current heading when the target has died', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 0, 100, 50);
    world.stores.health.current[target] = 0;
    const bolt = spawnHomingBolt(world, 0, 0, 1, 0, target, { activateFrame: 0 });

    world.frameCount = 0;
    homingSystem(world);

    expect(world.stores.velocity.x[bolt]).toBeCloseTo(1);
    expect(world.stores.velocity.y[bolt]).toBeCloseTo(0);
  });

  it('keeps its current heading when the target entity no longer exists', () => {
    const world = createTestWorld();
    const bolt = spawnHomingBolt(world, 0, 0, 1, 0, 9999, { activateFrame: 0 });

    world.frameCount = 0;
    homingSystem(world);

    expect(world.stores.velocity.x[bolt]).toBeCloseTo(1);
    expect(world.stores.velocity.y[bolt]).toBeCloseTo(0);
  });
});

describe('Glowing component', () => {
  it('can be attached to any entity independently of Prop/PropLight', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Position, { x: 5, y: 5 }));
    addComponent(
      world.ecs,
      eid,
      set(Glowing, { radiusPx: 48, intensity: 0.5, colorR: 0xc0, colorG: 0x84, colorB: 0xfc }),
    );

    expect(world.stores.glowing.radiusPx[eid]).toBe(48);
    expect(world.stores.glowing.intensity[eid]).toBeCloseTo(0.5);
    expect(world.stores.glowing.colorR[eid]).toBe(0xc0);
  });
});
