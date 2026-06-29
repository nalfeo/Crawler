import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Harvestable,
  Invincible,
  Npc,
  Owner,
  Position,
  Prop,
  PropLight,
  Sprite,
  Team,
  Trap,
} from '../../../src/core/components.js';
import {
  spawnHarvestableNode,
  spawnNpc,
  spawnProp,
  spawnTrap,
} from '../../../src/core/spawners/world-objects.js';
import { HARVESTABLE_DEFS } from '../../../src/shared/harvestableDefs.js';
import { createTestWorld } from '../../helpers/world-factory.js';

describe('spawnTrap', () => {
  it('stores trap geometry with an arm delay, owner, and team', () => {
    const world = createTestWorld();
    const eid = spawnTrap(world, 5, 6, 40, 2, 5, 750, 9, 1);

    expect(hasComponent(world.ecs, eid, Trap)).toBe(true);
    expect(hasComponent(world.ecs, eid, Owner)).toBe(true);
    expect(hasComponent(world.ecs, eid, Team)).toBe(true);
    expect(world.stores.trap.triggerRadius[eid]).toBe(2);
    expect(world.stores.trap.explosionRadius[eid]).toBe(5);
    expect(world.stores.trap.explosionDamage[eid]).toBe(40);
    expect(world.stores.trap.armAtMs[eid]).toBe(world.elapsedMs + 750);
    expect(world.stores.owner.eid[eid]).toBe(9);
    expect(world.stores.team.id[eid]).toBe(1);
    expect(world.stores.sprite.width[eid]).toBe(1.5);
  });
});

describe('spawnNpc', () => {
  it('creates a non-hostile, invincible NPC and registers an instance', () => {
    const world = createTestWorld();
    const eid = spawnNpc(world, 50, 75, 'tutorial-goon');

    expect(eid).toBeGreaterThanOrEqual(0);
    expect(hasComponent(world.ecs, eid, Npc)).toBe(true);
    expect(hasComponent(world.ecs, eid, Invincible)).toBe(true);
    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.position.x[eid]).toBe(50);
    expect(world.npcs.get(eid)?.defId).toBe('tutorial-goon');
  });

  it('returns -1 for an unknown defId', () => {
    const world = createTestWorld();
    expect(spawnNpc(world, 0, 0, 'does-not-exist')).toBe(-1);
  });
});

describe('spawnProp', () => {
  it('creates a prop without a light when the def has no lightEmission', () => {
    const world = createTestWorld();
    const eid = spawnProp(world, 1, 1, 'stone-pillar');

    expect(eid).toBeGreaterThanOrEqual(0);
    expect(hasComponent(world.ecs, eid, Prop)).toBe(true);
    expect(hasComponent(world.ecs, eid, PropLight)).toBe(false);
    expect(world.stores.prop.isDestructible[eid]).toBe(1);
    expect(world.stores.prop.isDestroyed[eid]).toBe(0);
    expect(world.stores.sprite.width[eid]).toBe(1.5);
  });

  it('adds a PropLight when the def emits light', () => {
    const world = createTestWorld();
    const eid = spawnProp(world, 0, 0, 'wall-sconce');

    expect(hasComponent(world.ecs, eid, PropLight)).toBe(true);
    expect(world.stores.propLight.radiusPx[eid]).toBeGreaterThan(0);
    expect(world.stores.propLight.intensity[eid]).toBeCloseTo(0.7);
  });

  it('returns -1 for an unknown defId', () => {
    const world = createTestWorld();
    expect(spawnProp(world, 0, 0, 'no-such-prop')).toBe(-1);
  });
});

describe('spawnHarvestableNode', () => {
  it('creates a static harvestable node mirroring its def duration', () => {
    const world = createTestWorld();
    const eid = spawnHarvestableNode(world, 8, 9, 0);

    expect(hasComponent(world.ecs, eid, Harvestable)).toBe(true);
    expect(world.stores.harvestable.defIndex[eid]).toBe(0);
    expect(world.stores.harvestable.durationMs[eid]).toBe(HARVESTABLE_DEFS[0]!.durationMs);
    expect(world.stores.harvestable.progressMs[eid]).toBe(0);
    expect(world.stores.harvestable.harvesterEid[eid]).toBe(0);
    expect(world.stores.sprite.width[eid]).toBe(1);
  });

  it('throws on an unknown defIndex', () => {
    const world = createTestWorld();
    expect(() => spawnHarvestableNode(world, 0, 0, 9999)).toThrow(/unknown defIndex/);
  });
});
