import { describe, expect, it } from 'vitest';
import { removeComponent } from 'bitecs';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  initializeFloor2Bosses,
  floor2ObjectiveTick,
  markDenUnlocked,
} from '../../src/game/floor2Scenario.js';
import { selectFloor2Roster } from '../../src/core/faction-relations.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';
import { Enemy, spawnPlayer } from '../../src/core/index.js';
import {
  captureBossEncounterSnapshots,
  diffBossEncounterSnapshots,
} from '../../src/game/ai/boss-encounter-telemetry.js';

/**
 * Regression: den softlock when the boss is outside its den at encounter start.
 *
 * The den doors RELOCK on the encounter's `activeGoalId`, which latches when the
 * player enters the den room. The boss is mobile and aggressive from floor init,
 * so once the unlock flag opens the doors it can walk out on its own. If the
 * encounter started with the boss elsewhere, the player was sealed into an empty
 * room with a boss that reads as `started` (HUD bar visible, damageable through
 * walls by homing spells) but is unreachable — and `activeGoalId` only clears on
 * the boss-death latch, so the doors never reopened.
 *
 * Reported on Floor 2 seed 42 (Queen Mab Tarnish / faeries).
 */

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

describe('Floor 2 boss den containment', () => {
  it('returns a strayed boss to its den before the encounter latches the door relock', () => {
    const seed = 7777;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources());
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const familyState = world.floorExtendedState.familyState!;
    const objectives = initializeFloor2Bosses(world, floorMap, familyState);

    const target = objectives[0]!;
    const encounter = familyState.bossEncounters!.get(target.familyId)!;
    const bossEid = encounter.bossEid!;

    markDenUnlocked(world, target.familyId);

    // Walk the boss out of its den, exactly as its AI can once the doors open.
    const outsideTile = findTileOutsideRoom(floorMap, encounter.roomId);
    const outsideWorld = floorMap.tileToWorld(outsideTile.x, outsideTile.y);
    world.stores.position.x[bossEid] = outsideWorld.x;
    world.stores.position.y[bossEid] = outsideWorld.y;
    expect(roomIdOfEntity(floorMap, world, bossEid)).not.toBe(encounter.roomId);

    // Player steps into the now-open den — this is what starts the encounter.
    // The recorded boss spawn is by construction inside the den room.
    spawnPlayer(world, encounter.bossSpawnX!, encounter.bossSpawnY!);
    world.state = 'playing';

    floor2ObjectiveTick(world);

    // The encounter started and the doors relocked...
    expect(encounter.started).toBe(true);
    expect(world.goalFlags.get(encounter.activeGoalId)).toBe(true);
    // ...so the boss MUST be inside the den the player is now sealed into.
    expect(roomIdOfEntity(floorMap, world, bossEid)).toBe(encounter.roomId);
  });

  it('telemetry reports the sealed-room invariant for every den encounter', () => {
    const seed = 7777;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources());
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const familyState = world.floorExtendedState.familyState!;
    const objectives = initializeFloor2Bosses(world, floorMap, familyState);
    const encounter = familyState.bossEncounters!.get(objectives[0]!.familyId)!;
    const bossEid = encounter.bossEid!;
    const playerEid = spawnPlayer(world, encounter.bossSpawnX!, encounter.bossSpawnY!);

    const atSpawn = captureBossEncounterSnapshots(world, playerEid);
    const denSnapshot = atSpawn.find((s) => s.familyId === String(encounter.familyId))!;
    expect(denSnapshot.bossInDen).toBe(true);
    expect(denSnapshot.denRoomId).toBe(encounter.roomId);
    expect(denSnapshot.doorsLocked).toBe(true);

    // Move the boss out of its den — the exact state that caused the softlock.
    const outside = findTileOutsideRoom(floorMap, encounter.roomId);
    const outsideWorld = floorMap.tileToWorld(outside.x, outside.y);
    world.stores.position.x[bossEid] = outsideWorld.x;
    world.stores.position.y[bossEid] = outsideWorld.y;

    const strayed = captureBossEncounterSnapshots(world, playerEid);
    const strayedSnapshot = strayed.find((s) => s.familyId === String(encounter.familyId))!;
    expect(strayedSnapshot.bossInDen).toBe(false);

    // And the transition is reported as a discrete, greppable note.
    const notes = diffBossEncounterSnapshots(atSpawn, strayed);
    expect(notes.some((n) => n.startsWith('boss left den'))).toBe(true);
  });

  it('does not relock a den when its boss entity is no longer a live enemy', () => {
    const seed = 42;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources());
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const familyState = world.floorExtendedState.familyState!;
    const objectives = initializeFloor2Bosses(world, floorMap, familyState);
    const encounter = familyState.bossEncounters!.get(objectives[0]!.familyId)!;

    markDenUnlocked(world, encounter.familyId);
    removeComponent(world.ecs, encounter.bossEid!, Enemy);
    spawnPlayer(world, encounter.bossSpawnX!, encounter.bossSpawnY!);
    world.state = 'playing';

    floor2ObjectiveTick(world);

    expect(encounter.started).toBe(false);
    expect(world.goalFlags.get(encounter.activeGoalId)).toBe(false);
  });

  it('returns a stuck boss to its den spawn when the nearest passable tile is outside the den', () => {
    const seed = 42;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources());
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const familyState = world.floorExtendedState.familyState!;
    const objectives = initializeFloor2Bosses(world, floorMap, familyState);
    const encounter = familyState.bossEncounters!.get(objectives[0]!.familyId)!;
    const bossEid = encounter.bossEid!;
    const stuckTile = findImpassableTileWithOutsideNearest(floorMap, encounter.roomId);
    const stuckWorld = floorMap.tileToWorld(stuckTile.x, stuckTile.y);
    world.stores.position.x[bossEid] = stuckWorld.x;
    world.stores.position.y[bossEid] = stuckWorld.y;
    world.state = 'playing';

    // `floor2ObjectiveTick` runs the private unstick routine before encounter work.
    floor2ObjectiveTick(world);

    expect(world.stores.position.x[bossEid]).toBe(encounter.bossSpawnX);
    expect(world.stores.position.y[bossEid]).toBe(encounter.bossSpawnY);
    expect(roomIdOfEntity(floorMap, world, bossEid)).toBe(encounter.roomId);
  });
});

function roomIdOfEntity(
  floorMap: ReturnType<CaveSystemGenerator['generate']>,
  world: ReturnType<typeof createTestWorld>,
  eid: number,
): number {
  const tile = floorMap.worldToTile(
    world.stores.position.x[eid] ?? 0,
    world.stores.position.y[eid] ?? 0,
  );
  return floorMap.roomGraph.getRoomAt(tile.x, tile.y);
}

function findTileOutsideRoom(
  floorMap: ReturnType<CaveSystemGenerator['generate']>,
  roomId: number,
): { x: number; y: number } {
  for (const room of floorMap.roomGraph.getAll()) {
    if (room.id === roomId) continue;
    const cell = room.interiorCells?.[0];
    if (cell) return { x: cell.x, y: cell.y };
  }
  throw new Error('no other room found in generated map');
}

function findImpassableTileWithOutsideNearest(
  floorMap: ReturnType<CaveSystemGenerator['generate']>,
  denRoomId: number,
): { x: number; y: number } {
  const { tileMap } = floorMap;
  for (let y = 0; y < tileMap.height; y += 1) {
    for (let x = 0; x < tileMap.width; x += 1) {
      if (tileMap.isPassable(x, y) || nearestPassableRoomId(floorMap, x, y) === denRoomId) {
        continue;
      }
      if (nearestPassableRoomId(floorMap, x, y) !== null) {
        return { x, y };
      }
    }
  }
  throw new Error('no impassable tile with an out-of-den nearest passable tile found');
}

function nearestPassableRoomId(
  floorMap: ReturnType<CaveSystemGenerator['generate']>,
  startX: number,
  startY: number,
): number | null {
  const { tileMap } = floorMap;
  for (let radius = 1; radius <= 6; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const x = startX + dx;
        const y = startY + dy;
        if (!tileMap.inBounds(x, y) || !tileMap.isPassable(x, y)) continue;
        return floorMap.roomGraph.getRoomAt(x, y);
      }
    }
  }
  return null;
}
