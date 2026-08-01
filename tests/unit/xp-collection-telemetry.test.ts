import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { BroadcastScore } from '../../src/core/components.js';
import { spawnPlayer, spawnXpGem } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { itemPickupSystem } from '../../src/core/systems/itemPickupSystem.js';
import {
  createXpCollectionTelemetry,
  recordCollectedXp,
  recordSpawnedXp,
  summarizeXpCollection,
} from '../../src/core/xp-collection-telemetry.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('xp collection telemetry', () => {
  it('is a no-op when disabled', () => {
    const world = createTestWorld();
    world.floorId = 'floor1';

    recordSpawnedXp(world, 5);
    recordCollectedXp(world, 5);

    expect(world.xpCollectionTelemetry).toBeUndefined();
    expect(summarizeXpCollection(world)).toBeUndefined();
  });

  it('reconciles spawned, collected, and live remaining XP', () => {
    const world = createTestWorld();
    world.floorId = 'floor1';
    world.xpCollectionTelemetry = createXpCollectionTelemetry(world.floorId, 0);
    const player = spawnPlayer(world, 0, 0);
    addComponent(world.ecs, player, set(BroadcastScore, { current: 0 }));
    spawnXpGem(world, 0.5, 0, 7);
    spawnXpGem(world, 100, 100, 5);

    itemPickupSystem(world, collisionSystem(world));

    expect(summarizeXpCollection(world)).toEqual({
      floors: [
        {
          floorId: 'floor1',
          floorStartPlayerXp: 0,
          spawned: 12,
          collected: 7,
          remaining: 5,
          efficiency: 7 / 12,
        },
      ],
    });
  });

  it('rotates epochs without mixing floor XP', () => {
    const world = createTestWorld();
    world.floorId = 'floor1';
    world.xpCollectionTelemetry = createXpCollectionTelemetry(world.floorId, 0);
    recordSpawnedXp(world, 10);
    recordCollectedXp(world, 4);

    world.floorId = 'floor2';
    world.playerLevel.xp = 66;
    recordSpawnedXp(world, 8);
    recordCollectedXp(world, 6);

    expect(summarizeXpCollection(world)).toEqual({
      floors: [
        {
          floorId: 'floor1',
          floorStartPlayerXp: 0,
          spawned: 10,
          collected: 4,
          remaining: 6,
          efficiency: 0.4,
        },
        {
          floorId: 'floor2',
          floorStartPlayerXp: 66,
          spawned: 8,
          collected: 6,
          remaining: 0,
          efficiency: 0.75,
        },
      ],
    });
  });

  it('uses zero efficiency for a zero-spawn epoch and excludes baseline player XP', () => {
    const world = createTestWorld();
    world.floorId = 'floor2';
    world.playerLevel.xp = 66;
    world.xpCollectionTelemetry = createXpCollectionTelemetry(world.floorId, world.playerLevel.xp);

    expect(summarizeXpCollection(world)?.floors[0]).toEqual({
      floorId: 'floor2',
      floorStartPlayerXp: 66,
      spawned: 0,
      collected: 0,
      remaining: 0,
      efficiency: 0,
    });
  });
});
