import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Sprite } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeFloor1Scenario } from '../../src/game/floor1Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

// Mirror of the module-local SPRITE_TEX_WELCOME_SIGN in floor1Scenario.ts and
// PhaserBridge.ts. Kept local so the test fails loudly if that id ever changes.
const WELCOME_SIGN_TEXTURE_ID = 3;

// A spread of seeds: the earlier adjacency bug produced zero signs on every
// seed, so we sample enough distinct dungeons to catch regressions.
const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 23, 42, 99, 256];

function welcomeSignEids(world: ReturnType<typeof createTestWorld>): number[] {
  return Array.from(query(world.ecs, [Sprite])).filter(
    (eid) => world.stores.sprite.textureId[eid] === WELCOME_SIGN_TEXTURE_ID,
  );
}

function initFloor1(seed: number): ReturnType<typeof createTestWorld> {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  return world;
}

describe('floor 1 welcome signs', () => {
  it('spawns at least one welcome sign on every seed', () => {
    for (const seed of SEEDS) {
      const signs = welcomeSignEids(initFloor1(seed));
      expect(signs.length, `seed ${seed} should spawn a welcome sign`).toBeGreaterThanOrEqual(1);
    }
  });

  it('always places a welcome sign in the spawn room', () => {
    for (const seed of SEEDS) {
      const world = initFloor1(seed);
      const floorMap = world.floorMap;
      expect(floorMap, `seed ${seed} should have a floor map`).not.toBeNull();

      const spawnRoom = floorMap!.spawnRoom;
      expect(spawnRoom, `seed ${seed} should have a spawn room`).not.toBeNull();

      const cx = Math.floor(spawnRoom!.bounds.x + spawnRoom!.bounds.width / 2);
      const cy = Math.floor(spawnRoom!.bounds.y + spawnRoom!.bounds.height / 2);
      const expected = floorMap!.tileToPixel(cx, cy);

      const hasSpawnRoomSign = welcomeSignEids(world).some(
        (eid) =>
          world.stores.position.x[eid] === expected.x &&
          world.stores.position.y[eid] === expected.y,
      );
      expect(hasSpawnRoomSign, `seed ${seed} should place a sign in the spawn room`).toBe(true);
    }
  });
});
