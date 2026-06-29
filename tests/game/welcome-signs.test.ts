import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Npc, Sprite } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  findNavigableRoomPathSteps,
  initializeFloor1Scenario,
  type NavigableRoomStep,
} from '../../src/game/floorScenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

// Mirror of the module-local SPRITE_TEX_WELCOME_SIGN in floor1Scenario.ts and
// PhaserBridge.ts. Kept local so the test fails loudly if that id ever changes.
const WELCOME_SIGN_TEXTURE_ID = 3;

// A spread of seeds: the earlier adjacency bug produced zero signs on every
// seed, so we sample enough distinct dungeons to catch regressions.
const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 23, 42, 99, 256];

function tileKeyAt(world: ReturnType<typeof createTestWorld>, eid: number): string {
  const floorMap = world.floorMap!;
  const tile = floorMap.worldToTile(
    world.stores.position.x[eid] ?? 0,
    world.stores.position.y[eid] ?? 0,
  );
  return `${tile.x},${tile.y}`;
}

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

function navigableRoomSteps(world: ReturnType<typeof createTestWorld>): NavigableRoomStep[] {
  const floorMap = world.floorMap!;
  const welcomeTile = floorMap.worldToTile(
    world.floor1!.objective.welcomeOfficePos.x,
    world.floor1!.objective.welcomeOfficePos.y,
  );
  return findNavigableRoomPathSteps(floorMap, floorMap.playerSpawn, welcomeTile) ?? [];
}

/** Tile-space centre of a room, matching floor1Scenario's `centerOfRoom`. */
function roomCenter(
  world: ReturnType<typeof createTestWorld>,
  roomId: number,
): { x: number; y: number } {
  const bounds = world.floorMap!.roomGraph.get(roomId)!.bounds;
  return {
    x: Math.floor(bounds.x + bounds.width / 2),
    y: Math.floor(bounds.y + bounds.height / 2),
  };
}

describe('floor 1 welcome signs', () => {
  it('spawns at least one welcome sign on every seed', () => {
    for (const seed of SEEDS) {
      const signs = welcomeSignEids(initFloor1(seed));
      expect(signs.length, `seed ${seed} should spawn a welcome sign`).toBeGreaterThanOrEqual(1);
    }
  });

  it('always places a welcome sign in the spawn room, but never on the player spawn tile', () => {
    for (const seed of SEEDS) {
      const world = initFloor1(seed);
      const floorMap = world.floorMap;
      expect(floorMap, `seed ${seed} should have a floor map`).not.toBeNull();

      const spawnRoom = floorMap!.spawnRoom;
      expect(spawnRoom, `seed ${seed} should have a spawn room`).not.toBeNull();

      const { x: rx, y: ry, width, height } = spawnRoom!.bounds;
      const spawnTile = floorMap!.playerSpawn;

      const signTiles = welcomeSignEids(world).map((eid) =>
        floorMap!.worldToTile(world.stores.position.x[eid] ?? 0, world.stores.position.y[eid] ?? 0),
      );

      // A sign still guides the player out of the spawn room...
      const hasSpawnRoomSign = signTiles.some(
        (t) => t.x >= rx && t.x < rx + width && t.y >= ry && t.y < ry + height,
      );
      expect(hasSpawnRoomSign, `seed ${seed} should place a sign in the spawn room`).toBe(true);

      // ...but no sign is ever planted directly under the player's spawn tile.
      const onSpawnTile = signTiles.some((t) => t.x === spawnTile.x && t.y === spawnTile.y);
      expect(onSpawnTile, `seed ${seed} must not place a sign on the spawn tile`).toBe(false);
    }
  });

  it('plants one sign in every room along the path (except the destination)', () => {
    for (const seed of SEEDS) {
      const world = initFloor1(seed);
      const steps = navigableRoomSteps(world);
      // Every room on the path except the destination gets exactly one sign.
      const expectedSignCount = Math.max(0, steps.length - 1);
      expect(
        welcomeSignEids(world).length,
        `seed ${seed} should plant one sign per path room minus the destination`,
      ).toBe(expectedSignCount);
    }
  });

  it('never plants a welcome sign on top of an NPC', () => {
    for (const seed of SEEDS) {
      const world = initFloor1(seed);
      const npcTiles = new Set(
        Array.from(query(world.ecs, [Npc])).map((eid) => tileKeyAt(world, eid)),
      );
      // NPCs exist to overlap with — otherwise the assertion is vacuous.
      expect(npcTiles.size, `seed ${seed} should spawn NPCs`).toBeGreaterThan(0);

      for (const signEid of welcomeSignEids(world)) {
        const signTile = tileKeyAt(world, signEid);
        expect(
          npcTiles.has(signTile),
          `seed ${seed} planted a welcome sign on an NPC at ${signTile}`,
        ).toBe(false);
      }
    }
  });

  it('regression: seed 18 points each sign at the door that leads onward, in every path room', () => {
    const world = initFloor1(18);
    const steps = navigableRoomSteps(world);
    // Seed 18 winds through a long chain of rooms — the original straight-to-goal
    // bug short-circuited this, so a long path is the regression's fingerprint.
    expect(steps.length).toBeGreaterThan(6);

    const signs = welcomeSignEids(world);
    // One sign per path room (excluding the destination). At most one room may
    // lack a free tile for a sign (e.g. the shop room, which has only one
    // passable interior tile occupied by the shopkeeper NPC when it sits on the
    // welcome path). So we allow signs.length >= steps.length - 2.
    expect(signs.length).toBeGreaterThanOrEqual(steps.length - 2);
    expect(signs.length).toBeLessThanOrEqual(steps.length - 1);

    // The welcome office is door-gated, so at least the approach into it is a
    // real DOOR tile — confirm the door-aware exit derivation actually fires.
    const doorExits = steps.slice(0, -1).filter((step) => step.exitDoor !== null);
    expect(doorExits.length, 'seed 20 path should cross at least one door').toBeGreaterThan(0);

    // Each sign's stored angle must point from its room centre at the tile the
    // player should head for: the recorded exit door, or (defensively) the next
    // room's centre when no door tile was flagged on that boundary. The
    // spawn-tile guard can nudge a sign's position by a tile but never its angle,
    // so comparing the angle multisets is robust to that shift.
    // We allow signs.length <= steps.length - 1 (one room may have no free tile),
    // so we check that actual angles are a subset of expected angles.
    const expectedAngles = steps
      .slice(0, -1)
      .map((step, i) => {
        const center = roomCenter(world, step.roomId);
        const target = step.exitDoor ?? roomCenter(world, steps[i + 1]!.roomId);
        return Math.atan2(target.y - center.y, target.x - center.x);
      })
      .sort((a, b) => a - b);

    const actualAngles = signs
      .map((eid) => world.stores.rotation.angle[eid] ?? 0)
      .sort((a, b) => a - b);

    // Every placed sign must match one of the expected angles (subset check).
    const remaining = [...expectedAngles];
    for (const actual of actualAngles) {
      const idx = remaining.findIndex((exp) => Math.abs(actual - exp) < 1e-5);
      expect(idx, `sign angle ${actual} not found in expected angles`).toBeGreaterThanOrEqual(0);
      remaining.splice(idx, 1);
    }
  });
});
