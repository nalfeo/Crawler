import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../../src/shared/random';
import { BiomeType, RoomRole, TerrainType } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system';
import { getGenerator } from '../../src/core/map/generators/registry';

/** Small config for fast tests. */
function smallConfig(seed: number, widthTiles = 80, heightTiles = 60): MapConfig {
  return {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

function generateWithPresent(seed: number, presentCount: number, w = 80, h = 60) {
  const gen = new CaveSystemGenerator({ presentCount });
  return gen.generate(smallConfig(seed, w, h), new SeededRandom(seed));
}

function bfsReachable(
  floor: { tileMap: { isPassable: (x: number, y: number) => boolean } },
  sx: number,
  sy: number,
  w: number,
  h: number,
): Uint8Array {
  const seen = new Uint8Array(w * h);
  const q: number[] = [sy * w + sx];
  seen[sy * w + sx] = 1;
  let head = 0;
  while (head < q.length) {
    const idx = q[head++]!;
    const x = idx % w;
    const y = (idx / w) | 0;
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (seen[ni]) continue;
      if (!floor.tileMap.isPassable(nx, ny)) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  return seen;
}

describe('CaveSystemGenerator', () => {
  it('registers under BiomeType.CAVE_SYSTEM', () => {
    const g = getGenerator(BiomeType.CAVE_SYSTEM);
    expect(g.name).toBe('CaveSystemGenerator');
  });

  it('is deterministic: same seed → identical output', () => {
    const a = generateWithPresent(1234, 4);
    const b = generateWithPresent(1234, 4);
    expect(a.tileMap.flags).toEqual(b.tileMap.flags);
    expect(a.terrain).toEqual(b.terrain);
    expect(a.roomGraph.getAll().length).toBe(b.roomGraph.getAll().length);
    expect(a.playerSpawn).toEqual(b.playerSpawn);
  });

  it('produces exactly the required role counts for presentCount=4', () => {
    const floor = generateWithPresent(7, 4);
    const rooms = floor.roomGraph.getAll();
    const byRole = (role: RoomRole) => rooms.filter((r) => r.role === role);
    expect(byRole(RoomRole.SPAWN).length).toBe(1);
    expect(byRole(RoomRole.SETTLEMENT).length).toBe(1);
    expect(byRole(RoomRole.RESOURCE_HEART).length).toBe(1);
    expect(byRole(RoomRole.TERRITORY).length).toBe(4);
    expect(byRole(RoomRole.BOSS_DEN).length).toBe(4);
  });

  it('produces exactly the required role counts for presentCount=3', () => {
    const floor = generateWithPresent(11, 3);
    const rooms = floor.roomGraph.getAll();
    const byRole = (role: RoomRole) => rooms.filter((r) => r.role === role);
    expect(byRole(RoomRole.TERRITORY).length).toBe(3);
    expect(byRole(RoomRole.BOSS_DEN).length).toBe(3);
  });

  it('assigns unique familyIndex 0..N-1 to territories and boss dens', () => {
    const floor = generateWithPresent(42, 4);
    const rooms = floor.roomGraph.getAll();
    const territoryIndices = rooms
      .filter((r) => r.role === RoomRole.TERRITORY)
      .map((r) => r.familyIndex)
      .sort();
    const denIndices = rooms
      .filter((r) => r.role === RoomRole.BOSS_DEN)
      .map((r) => r.familyIndex)
      .sort();
    expect(territoryIndices).toEqual([0, 1, 2, 3]);
    expect(denIndices).toEqual([0, 1, 2, 3]);
  });

  it('resource-heart room has BOSS_STAIR_FLOOR terrain at its centre', () => {
    const floor = generateWithPresent(5, 4);
    const heart = floor.roomGraph.getAll().find((r) => r.role === RoomRole.RESOURCE_HEART)!;
    const cx = heart.bounds.x + Math.floor(heart.bounds.width / 2);
    const cy = heart.bounds.y + Math.floor(heart.bounds.height / 2);
    const w = floor.config.widthTiles;
    // Search a small neighbourhood — the stamp is at the region centroid,
    // which is within (but not necessarily the mathematical centre of) bounds.
    let found = false;
    for (let dy = -8; dy <= 8 && !found; dy++) {
      for (let dx = -8; dx <= 8 && !found; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= floor.config.heightTiles) continue;
        if (floor.terrain[ny * w + nx] === TerrainType.BOSS_STAIR_FLOOR) found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('every labelled cavern is reachable from the player spawn', () => {
    const seeds = [1, 2, 3, 10, 100, 555, 9999];
    for (const seed of seeds) {
      const floor = generateWithPresent(seed, 4);
      const w = floor.config.widthTiles;
      const h = floor.config.heightTiles;
      const reached = bfsReachable(floor, floor.playerSpawn.x, floor.playerSpawn.y, w, h);
      const labelled = floor.roomGraph
        .getAll()
        .filter((r) =>
          [RoomRole.TERRITORY, RoomRole.SETTLEMENT, RoomRole.RESOURCE_HEART].includes(r.role),
        );
      for (const room of labelled) {
        // Reachable if any tile in a 5×5 around the room bounds centre is reached.
        const cx = room.bounds.x + Math.floor(room.bounds.width / 2);
        const cy = room.bounds.y + Math.floor(room.bounds.height / 2);
        let ok = false;
        for (let dy = -3; dy <= 3 && !ok; dy++) {
          for (let dx = -3; dx <= 3 && !ok; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            if (reached[ny * w + nx]) ok = true;
          }
        }
        expect(ok, `seed=${seed} role=${room.role} unreachable`).toBe(true);
      }
      // Boss-den doors reachable too (via an adjacent floor tile — the door
      // itself is DOOR_CLOSED and not "passable" until the player opens it).
      const dens = floor.roomGraph.getAll().filter((r) => r.role === RoomRole.BOSS_DEN);
      for (const den of dens) {
        const door = den.doors[0]!;
        let doorOk = false;
        for (let dy = -1; dy <= 1 && !doorOk; dy++) {
          for (let dx = -1; dx <= 1 && !doorOk; dx++) {
            const nx = door.x + dx;
            const ny = door.y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            if (reached[ny * w + nx]) doorOk = true;
          }
        }
        expect(doorOk, `seed=${seed} boss-den door has no reached neighbour`).toBe(true);
      }
    }
  });

  it('throws with a clear diagnostic when reachability cannot be satisfied', () => {
    // Force zero retries + tiny map + tight separation to make generation fail fast.
    const gen = new CaveSystemGenerator({
      presentCount: 4,
      maxRetries: 1,
      regionSeparationTiles: 100, // impossible on 20x20
    });
    const cfg: MapConfig = {
      widthTiles: 20,
      heightTiles: 20,
      tileSizeFt: 4,
      biome: BiomeType.CAVE_SYSTEM,
      seed: 1,
      roomWidthRange: [3, 6],
      roomHeightRange: [3, 6],
      maxRooms: 4,
      floorDensity: 0.45,
    };
    expect(() => gen.generate(cfg, new SeededRandom(1))).toThrowError(/exhausted/);
  });

  it('rejects presentCount < 1', () => {
    expect(() => new CaveSystemGenerator({ presentCount: 0 })).toThrowError(/presentCount/);
  });
});
