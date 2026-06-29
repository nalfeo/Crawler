import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  AreaDamage,
  Lifetime,
  MeleeSwing,
  Owner,
  Position,
  Sprite,
  Team,
} from '../../../src/core/components.js';
import { spawnAreaAttack, spawnMeleeSwing } from '../../../src/core/spawners/melee.js';
import { createTestWorld } from '../../helpers/world-factory.js';

describe('spawnAreaAttack', () => {
  it('creates an omnidirectional area attack when no arc is given', () => {
    const world = createTestWorld();
    const eid = spawnAreaAttack(world, 1, 2, 5, 14, 6, 300, 1);

    expect(hasComponent(world.ecs, eid, AreaDamage)).toBe(true);
    expect(hasComponent(world.ecs, eid, Lifetime)).toBe(true);
    expect(hasComponent(world.ecs, eid, Owner)).toBe(true);
    expect(hasComponent(world.ecs, eid, Team)).toBe(true);
    expect(world.stores.areaDamage.radius[eid]).toBe(6);
    expect(world.stores.areaDamage.damage[eid]).toBe(14);
    expect(world.stores.areaDamage.hitOnce[eid]).toBe(1);
    expect(world.stores.areaDamage.arcCenterRad[eid]).toBe(0);
    expect(world.stores.areaDamage.arcHalfRad[eid]).toBe(0);
    expect(world.stores.lifetime.expiresAtMs[eid]).toBe(world.elapsedMs + 300);
    expect(world.stores.owner.eid[eid]).toBe(5);
    expect(world.stores.team.id[eid]).toBe(1);
    expect(world.stores.sprite.width[eid]).toBe(12);
  });

  it('computes arc center/half angles from direction + arcDeg', () => {
    const world = createTestWorld();
    const eid = spawnAreaAttack(world, 0, 0, 1, 10, 4, 100, 1, 1, 0, 90);

    expect(world.stores.areaDamage.arcCenterRad[eid]).toBeCloseTo(0);
    expect(world.stores.areaDamage.arcHalfRad[eid]).toBeCloseTo((45 * Math.PI) / 180);
  });

  it('ignores a full-circle arc (>=360) and stays omnidirectional', () => {
    const world = createTestWorld();
    const eid = spawnAreaAttack(world, 0, 0, 1, 10, 4, 100, 1, 1, 0, 360);
    expect(world.stores.areaDamage.arcHalfRad[eid]).toBe(0);
  });
});

describe('spawnMeleeSwing', () => {
  it('stores swing geometry, lifetime, owner, team, and sprite size', () => {
    const world = createTestWorld();
    const eid = spawnMeleeSwing(world, 3, 4, 7, 20, 5, 250, 0, 1, 60, 2, 1, 1.5, 0.75, 10, 2);

    expect(hasComponent(world.ecs, eid, MeleeSwing)).toBe(true);
    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.meleeSwing.bladeLength[eid]).toBe(5);
    expect(world.stores.meleeSwing.arcCenterRad[eid]).toBeCloseTo(Math.PI / 2);
    expect(world.stores.meleeSwing.arcHalfRad[eid]).toBeCloseTo((30 * Math.PI) / 180);
    expect(world.stores.meleeSwing.damage[eid]).toBe(20);
    expect(world.stores.meleeSwing.spawnAtMs[eid]).toBe(world.elapsedMs);
    expect(world.stores.meleeSwing.durationMs[eid]).toBe(250);
    expect(world.stores.meleeSwing.style[eid]).toBe(1);
    expect(world.stores.meleeSwing.headRadius[eid]).toBeCloseTo(1.5);
    expect(world.stores.meleeSwing.shaftDamageMult[eid]).toBeCloseTo(0.75);
    expect(world.stores.meleeSwing.knockback[eid]).toBe(10);
    expect(world.stores.meleeSwing.spriteId[eid]).toBe(2);
    expect(world.stores.lifetime.expiresAtMs[eid]).toBe(world.elapsedMs + 250);
    expect(world.stores.owner.eid[eid]).toBe(7);
    expect(world.stores.team.id[eid]).toBe(2);
    expect(world.stores.sprite.width[eid]).toBe(10);
  });
});
