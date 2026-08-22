import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { BloodColor } from '../../../src/core/components.js';
import {
  DEFAULT_BLOOD_COLOR,
  clearEntityStores,
  createEntity,
  setBloodColor,
} from '../../../src/core/spawners/entity-core.js';
import { spawnEnemy } from '../../../src/core/spawners/combatants.js';
import { addSetPieceProp } from '../../../src/core/spawners/world-objects.js';
import { createTestWorld } from '../../helpers/world-factory.js';

describe('createEntity', () => {
  it('returns an entity with zeroed stores even after ID recycling', () => {
    const world = createTestWorld();

    // Dirty a store slot manually at ID 0
    world.stores.position.x[0] = 124.875;
    world.stores.health.current[0] = 42;

    const eid = createEntity(world);

    expect(world.stores.position.x[eid]).toBe(0);
    expect(world.stores.health.current[eid]).toBe(0);
  });
});

describe('clearEntityStores', () => {
  it('zeros all typed-array store slots for an entity', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 12.5, 25, 50);

    expect(world.stores.position.x[eid]).toBe(12.5);
    expect(world.stores.health.current[eid]).toBe(50);

    clearEntityStores(world, eid);

    expect(world.stores.position.x[eid]).toBe(0);
    expect(world.stores.position.y[eid]).toBe(0);
    expect(world.stores.health.current[eid]).toBe(0);
    expect(world.stores.health.max[eid]).toBe(0);
    expect(world.stores.sprite.width[eid]).toBe(0);
    expect(world.stores.enemyBehavior.type[eid]).toBe(0);
    expect(world.stores.enemyBehavior.speed[eid]).toBe(0);
  });

  it('leaves the render-only setPieceProps list untouched (set-piece props are not entities)', () => {
    const world = createTestWorld();
    const render = {
      widthFt: 16,
      heightFt: 8,
      depth: -19,
      sprite: { source: 'custom', requestId: 'welcome-room-rug', label: 'rug', prompt: 'a rug' },
    } as const;
    addSetPieceProp(world, 1, 2, render);
    const eid = spawnEnemy(world, 5, 5, 10);

    clearEntityStores(world, eid);

    // Set-piece props live on a render-only list, not the entity space, so
    // recycling an entity id must never disturb them (they consume no eid).
    expect(world.setPieceProps).toHaveLength(1);
    expect(world.setPieceProps[0]?.render).toBe(render);
  });

  it('purges a cleared entity as a companionDamageContribution target', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 5, 5, 10);
    const contributor = spawnEnemy(world, 6, 6, 10);
    world.companionDamageContribution.set(target, new Map([[contributor, 15]]));

    clearEntityStores(world, target);

    // The recycled target eid must not resurface as a tracked kill: a
    // recycled EID whose Health.current happens to read <= 0 could otherwise
    // be misread by companionProgressionSystem as this stale target's death.
    expect(world.companionDamageContribution.has(target)).toBe(false);
    // The contributor's own ledger entry (as a target) is untouched.
    expect(world.companionDamageContribution.has(contributor)).toBe(false);
  });

  it('purges a cleared entity as a companionDamageContribution contributor without dropping other contributors', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 5, 5, 10);
    const staleContributor = spawnEnemy(world, 6, 6, 10);
    const liveContributor = spawnEnemy(world, 7, 7, 10);
    world.companionDamageContribution.set(
      target,
      new Map([
        [staleContributor, 15],
        [liveContributor, 20],
      ]),
    );

    clearEntityStores(world, staleContributor);

    // A recycled contributor eid must not inherit stale XP credit for damage
    // it never dealt, but the target's entry and the other contributor's
    // credit must survive.
    const contributions = world.companionDamageContribution.get(target);
    expect(contributions?.has(staleContributor)).toBe(false);
    expect(contributions?.get(liveContributor)).toBe(20);
  });
});

describe('setBloodColor', () => {
  it('adds BloodColor and unpacks the packed 0xRRGGBB integer into channels', () => {
    const world = createTestWorld();
    const eid = createEntity(world);

    setBloodColor(world, eid, 0x12345a);

    expect(hasComponent(world.ecs, eid, BloodColor)).toBe(true);
    expect(world.stores.bloodColor.r[eid]).toBe(0x12);
    expect(world.stores.bloodColor.g[eid]).toBe(0x34);
    expect(world.stores.bloodColor.b[eid]).toBe(0x5a);
  });
});

describe('DEFAULT_BLOOD_COLOR re-export', () => {
  it('is the shared default red', () => {
    expect(DEFAULT_BLOOD_COLOR).toBe(0xcc0000);
  });
});
