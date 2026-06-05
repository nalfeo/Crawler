import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Health, Player } from '../../src/core/components.js';
import { applyDamage } from '../../src/core/apply-damage.js';
import { createEntity } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('applyDamage', () => {
  it('reduces target HP by the requested amount', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 100, max: 100 }));
    world.stores.health.current[eid] = 100;

    const dealt = applyDamage(world, eid, 30, 10, 20);

    expect(dealt).toBe(30);
    expect(world.stores.health.current[eid]).toBe(70);
  });

  it('clamps dealt damage to remaining HP (overkill)', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 15, max: 100 }));
    world.stores.health.current[eid] = 15;

    const dealt = applyDamage(world, eid, 50, 0, 0);

    expect(dealt).toBe(15);
    expect(world.stores.health.current[eid]).toBe(0);
  });

  it('emits a CombatEvent with the actual dealt amount (not requested)', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 10, max: 100 }));
    world.stores.health.current[eid] = 10;

    applyDamage(world, eid, 25, 5, 7);

    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'hit',
      x: 5,
      y: 7,
      amount: 10, // clamped to remaining HP, not 25
      targetEid: eid,
    });
  });

  it('does not emit a CombatEvent when dealt damage is 0', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 0, max: 100 }));
    world.stores.health.current[eid] = 0;

    const dealt = applyDamage(world, eid, 10, 0, 0);

    expect(dealt).toBe(0);
    expect(world.combatEvents).toHaveLength(0);
  });

  it('sets targetType to "player" for Player entities', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, eid, Player);
    world.stores.health.current[eid] = 50;

    applyDamage(world, eid, 10, 1, 2);

    expect(world.combatEvents[0]!.targetType).toBe('player');
  });

  it('sets targetType to "enemy" for non-Player entities', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));
    world.stores.health.current[eid] = 50;

    applyDamage(world, eid, 10, 1, 2);

    expect(world.combatEvents[0]!.targetType).toBe('enemy');
  });

  it('includes timestamp from world.elapsedMs', () => {
    const world = createTestWorld();
    world.elapsedMs = 12345;
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));
    world.stores.health.current[eid] = 50;

    applyDamage(world, eid, 5, 0, 0);

    expect(world.combatEvents[0]!.timestamp).toBe(12345);
  });
});
