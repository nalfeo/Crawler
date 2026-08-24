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

function smallFloor3Config(seed: number, widthTiles = 96, heightTiles = 96): MapConfig {
  return {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM_BIOMES,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
    caveSystem: { presentCount: 7, layout: 'floor3-biomes' },
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

function expectRoomPerimeterSealed(
  floor: {
    width: number;
    terrain: Uint8Array;
    tileMap: { isPassable: (x: number, y: number) => boolean };
  },
  room: {
    id: number;
    role: RoomRole;
    bounds: { x: number; y: number; width: number; height: number };
    doors: ReadonlyArray<{ x: number; y: number }>;
  },
  seed: number,
): void {
  const x0 = room.bounds.x;
  const y0 = room.bounds.y;
  const x1 = room.bounds.x + room.bounds.width - 1;
  const y1 = room.bounds.y + room.bounds.height - 1;
  const doorSet = new Set(room.doors.map((door) => `${door.x},${door.y}`));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const perimeter = x === x0 || x === x1 || y === y0 || y === y1;
      if (!perimeter) continue;
      const idx = y * floor.width + x;
      if (doorSet.has(`${x},${y}`)) {
        expect(
          floor.tileMap.isPassable(x, y),
          `seed=${seed} room=${room.id} door blocked at (${x},${y})`,
        ).toBe(true);
        expect(
          floor.terrain[idx],
          `seed=${seed} room=${room.id} unexpected door terrain at (${x},${y})`,
        ).not.toBe(TerrainType.STONE_WALL);
        expect(
          floor.terrain[idx],
          `seed=${seed} room=${room.id} unexpected door terrain at (${x},${y})`,
        ).not.toBe(TerrainType.CAVE_WALL);
      } else {
        expect(
          floor.terrain[idx],
          `seed=${seed} room=${room.id} (${room.role}) has open perimeter at (${x},${y})`,
        ).toBe(TerrainType.STONE_WALL);
        expect(floor.tileMap.isPassable(x, y)).toBe(false);
      }
    }
  }
}

describe('CaveSystemGenerator', () => {
  it('registers under BiomeType.CAVE_SYSTEM', () => {
    const g = getGenerator(BiomeType.CAVE_SYSTEM);
    expect(g.name).toBe('CaveSystemGenerator');
  });

  it('registers the floor3 biome-overworld layout', () => {
    const g = getGenerator(BiomeType.CAVE_SYSTEM_BIOMES);
    expect(g.name).toBe('CaveSystemGenerator');
    const floor = g.generate(smallFloor3Config(91), new SeededRandom(91));
    expect(floor.territoryZones).toHaveLength(7);
  });

  it('is deterministic: same seed → identical output', () => {
    const a = generateWithPresent(1234, 4);
    const b = generateWithPresent(1234, 4);
    expect(a.tileMap.flags).toEqual(b.tileMap.flags);
    expect(a.terrain).toEqual(b.terrain);
    expect(a.roomGraph.getAll().length).toBe(b.roomGraph.getAll().length);
    expect(a.playerSpawn).toEqual(b.playerSpawn);
  });

  it('builds deterministic floor3 biome territory zones with no Floor 2-only rooms', () => {
    const generator = getGenerator(BiomeType.CAVE_SYSTEM_BIOMES);
    const config = smallFloor3Config(4321);
    const left = generator.generate(config, new SeededRandom(4321));
    const right = generator.generate(config, new SeededRandom(4321));

    expect(left.terrain).toEqual(right.terrain);
    expect(left.playerSpawn).toEqual(right.playerSpawn);
    expect(left.territoryZones).toEqual(right.territoryZones);
    expect(left.territoryZones).toHaveLength(7);

    const rooms = left.roomGraph.getAll();
    expect(rooms.filter((room) => room.role === RoomRole.SPAWN)).toHaveLength(1);
    expect(rooms.filter((room) => room.role === RoomRole.TERRITORY)).toHaveLength(7);
    expect(rooms.filter((room) => room.role === RoomRole.BOSS_DEN)).toHaveLength(0);
    expect(rooms.filter((room) => room.role === RoomRole.SETTLEMENT)).toHaveLength(0);
    expect(rooms.filter((room) => room.role === RoomRole.RESOURCE_HEART)).toHaveLength(0);
  });

  it('enlarges the floor3 spawn/entrance room (issue: too small for the starter-pick UX) while staying reachable', () => {
    // Regression coverage for the entrance-room-size complaint: bumping
    // `spawnSizeCandidates` from [6,5,4] to [12,10,8] must hold across seeds
    // without breaking reachability or the room-role invariants the floor3
    // biome-overworld layout otherwise guarantees.
    const generator = getGenerator(BiomeType.CAVE_SYSTEM_BIOMES);
    for (const seed of [4321, 91, 1, 555, 9999]) {
      const config = smallFloor3Config(seed);
      const floor = generator.generate(config, new SeededRandom(seed));
      const spawnRoom = floor.roomGraph.getAll().find((room) => room.role === RoomRole.SPAWN);
      expect(spawnRoom, `seed=${seed} missing spawn room`).toBeDefined();
      expect(
        spawnRoom!.bounds.width,
        `seed=${seed} spawn room too small (width)`,
      ).toBeGreaterThanOrEqual(8);
      expect(
        spawnRoom!.bounds.height,
        `seed=${seed} spawn room too small (height)`,
      ).toBeGreaterThanOrEqual(8);

      const w = floor.config.widthTiles;
      const h = floor.config.heightTiles;
      const reached = bfsReachable(floor, floor.playerSpawn.x, floor.playerSpawn.y, w, h);
      expect(reached[floor.playerSpawn.y * w + floor.playerSpawn.x], `seed=${seed}`).toBe(1);
    }
  });

  it('produces exactly the required role counts for presentCount=4', () => {
    const floor = generateWithPresent(7, 4);
    const rooms = floor.roomGraph.getAll();
    const byRole = (role: RoomRole) => rooms.filter((r) => r.role === role);
    expect(byRole(RoomRole.SPAWN).length).toBe(1);
    expect(byRole(RoomRole.SETTLEMENT).length).toBeGreaterThanOrEqual(2);
    expect(byRole(RoomRole.SETTLEMENT).length).toBeLessThanOrEqual(3);
    expect(byRole(RoomRole.RESOURCE_HEART).length).toBe(1);
    expect(byRole(RoomRole.TERRITORY).length).toBe(4);
    expect(byRole(RoomRole.BOSS_DEN).length).toBe(4);
  });

  it('produces exactly the required role counts for presentCount=3', () => {
    const floor = generateWithPresent(11, 3);
    const rooms = floor.roomGraph.getAll();
    const byRole = (role: RoomRole) => rooms.filter((r) => r.role === role);
    expect(byRole(RoomRole.SETTLEMENT).length).toBeGreaterThanOrEqual(2);
    expect(byRole(RoomRole.SETTLEMENT).length).toBeLessThanOrEqual(3);
    expect(byRole(RoomRole.TERRITORY).length).toBe(3);
    expect(byRole(RoomRole.BOSS_DEN).length).toBe(3);
  });

  it('always includes a settlement bar room with 1-2 adjacent annex rooms', () => {
    for (const seed of [1, 7, 13, 42, 99, 500]) {
      const floor = generateWithPresent(seed, 4);
      const settlements = floor.roomGraph
        .getAll()
        .filter((room) => room.role === RoomRole.SETTLEMENT);
      expect(settlements.length).toBeGreaterThanOrEqual(2);
      expect(settlements.length).toBeLessThanOrEqual(3);
      const bar = settlements.find((room) => room.label === 'settlement_bar');
      expect(bar, `seed=${seed} missing settlement_bar`).toBeDefined();
      const annexes = settlements.filter((room) => room.label?.startsWith('settlement_annex_'));
      expect(annexes.length).toBe(settlements.length - 1);
      const barNeighbours = floor.roomGraph
        .getConnectedRooms(bar!.id)
        .filter((room) => room.role === RoomRole.SETTLEMENT);
      expect(barNeighbours.length).toBe(annexes.length);
    }
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

  it('places a sealed circular resource-heart room near map center (diameter 20)', () => {
    const floor = generateWithPresent(77, 4, 120, 90);
    const heart = floor.roomGraph.getAll().find((r) => r.role === RoomRole.RESOURCE_HEART)!;
    expect(heart.bounds.width).toBe(21);
    expect(heart.bounds.height).toBe(21);
    expect(heart.doors.length).toBe(1);

    const heartCenterX = heart.bounds.x + Math.floor(heart.bounds.width / 2);
    const heartCenterY = heart.bounds.y + Math.floor(heart.bounds.height / 2);
    const mapCenterX = Math.floor(floor.width / 2);
    const mapCenterY = Math.floor(floor.height / 2);
    const maxOffset = Math.floor(Math.min(floor.width, floor.height) * 0.2);
    expect(Math.abs(heartCenterX - mapCenterX)).toBeLessThanOrEqual(maxOffset);
    expect(Math.abs(heartCenterY - mapCenterY)).toBeLessThanOrEqual(maxOffset);
  });

  it('applies configurable resource-heart diameter', () => {
    const gen = new CaveSystemGenerator({ presentCount: 4 });
    const config: MapConfig = {
      ...smallConfig(33, 140, 110),
      caveSystem: { resourceHeartDiameterTiles: 28 },
    };
    const floor = gen.generate(config, new SeededRandom(33));
    const heart = floor.roomGraph.getAll().find((r) => r.role === RoomRole.RESOURCE_HEART)!;
    expect(heart.bounds.width).toBe(29);
    expect(heart.bounds.height).toBe(29);
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
      // Boss-den doors reachable too (via an adjacent floor tile — runtime can
      // close these doors later).
      const dens = floor.roomGraph.getAll().filter((r) => r.role === RoomRole.BOSS_DEN);
      for (const den of dens) {
        for (let doorIndex = 0; doorIndex < den.doors.length; doorIndex++) {
          const door = den.doors[doorIndex]!;
          let doorOk = false;
          for (let dy = -1; dy <= 1 && !doorOk; dy++) {
            for (let dx = -1; dx <= 1 && !doorOk; dx++) {
              const nx = door.x + dx;
              const ny = door.y + dy;
              if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
              if (reached[ny * w + nx]) doorOk = true;
            }
          }
          expect(doorOk, `seed=${seed} boss-den door[${doorIndex}] has no reached neighbour`).toBe(
            true,
          );
        }
      }
    }
  });

  it('keeps every passable tile connected to spawn after settlement/den carving', () => {
    for (const seed of [1, 2, 3, 7, 11, 42, 99, 123, 777, 1024]) {
      const floor = generateWithPresent(seed, 4);
      const w = floor.config.widthTiles;
      const h = floor.config.heightTiles;
      const reached = bfsReachable(floor, floor.playerSpawn.x, floor.playerSpawn.y, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!floor.tileMap.isPassable(x, y)) continue;
          expect(
            reached[y * w + x],
            `seed=${seed} has disconnected passable tile at (${x},${y})`,
          ).toBe(1);
        }
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

  it('clamps config caveSystem.presentCount to generator bounds', () => {
    const gen = new CaveSystemGenerator({ presentCount: 4 });
    const config: MapConfig = {
      ...smallConfig(1234),
      caveSystem: { presentCount: 99 },
    };
    const floor = gen.generate(config, new SeededRandom(1234));
    const territoryCount = floor.roomGraph
      .getAll()
      .filter((room) => room.role === RoomRole.TERRITORY).length;
    expect(territoryCount).toBe(4);
  });

  it('clamps regionSeparationTiles to map corner-to-corner diagonal', () => {
    const widthTiles = 20;
    const heightTiles = 20;
    const diagonal = Math.floor(Math.hypot(widthTiles - 1, heightTiles - 1));
    const gen = new CaveSystemGenerator({
      presentCount: 4,
      maxRetries: 1,
    });
    const config: MapConfig = {
      widthTiles,
      heightTiles,
      tileSizeFt: 4,
      biome: BiomeType.CAVE_SYSTEM,
      seed: 1,
      roomWidthRange: [3, 6],
      roomHeightRange: [3, 6],
      maxRooms: 4,
      floorDensity: 0.45,
      caveSystem: { regionSeparationTiles: 9999 },
    };
    expect(() => gen.generate(config, new SeededRandom(1))).toThrowError(
      new RegExp(`sep=${diagonal}`),
    );
  });

  it('BOSS_STAIR_FLOOR is stamped inside the RESOURCE_HEART region on every seed', () => {
    // Guards against the "centroid falls on a wall pocket -> stamps zero tiles" bug
    // that neither the reachability check nor the bounds-centered search would catch.
    for (const seed of [1, 2, 3, 4, 5, 7, 11, 42, 100, 12345]) {
      const floor = generateWithPresent(seed, 4);
      const w = floor.config.widthTiles;
      let count = 0;
      for (let i = 0; i < floor.terrain.length; i++) {
        if (floor.terrain[i] === TerrainType.BOSS_STAIR_FLOOR) count++;
      }
      expect(count, `seed=${seed} produced no BOSS_STAIR_FLOOR tile`).toBeGreaterThanOrEqual(1);
      const heart = floor.roomGraph.getAll().find((r) => r.role === RoomRole.RESOURCE_HEART)!;
      const { x, y, width, height } = heart.bounds;
      for (let ty = 0; ty < floor.config.heightTiles; ty++) {
        for (let tx = 0; tx < w; tx++) {
          if (floor.terrain[ty * w + tx] !== TerrainType.BOSS_STAIR_FLOOR) continue;
          expect(
            tx >= x && tx < x + width && ty >= y && ty < y + height,
            `seed=${seed} BOSS_STAIR_FLOOR at ${tx},${ty} outside RESOURCE_HEART bounds`,
          ).toBe(true);
        }
      }
    }
  });

  it('open cave regions register non-empty semantic adjacency in RoomGraph', () => {
    const floor = generateWithPresent(42, 4);
    const roles = [
      RoomRole.SPAWN,
      RoomRole.TERRITORY,
      RoomRole.SETTLEMENT,
      RoomRole.RESOURCE_HEART,
    ];
    for (const room of floor.roomGraph.getAll()) {
      if (!roles.includes(room.role)) continue;
      const neighbours = floor.roomGraph.getConnectedRooms(room.id);
      expect(neighbours.length, `room ${room.id} (${room.role}) has no neighbours`).toBeGreaterThan(
        0,
      );
    }
  });

  it('floor.territoryZones.length equals presentCount', () => {
    for (const [seed, count] of [
      [7, 4],
      [11, 3],
      [42, 4],
    ] as const) {
      const floor = generateWithPresent(seed, count);
      expect(floor.territoryZones.length).toBe(count);
      const indices = floor.territoryZones.map((z) => z.familyIndex).sort();
      expect(indices).toEqual(Array.from({ length: count }, (_, i) => i));
    }
  });

  it('uses 30%-diameter circular family territory zones from den centers', () => {
    const floor = generateWithPresent(42, 4, 120, 90);
    const expectedRadius = Math.floor(Math.round(Math.min(120, 90) * 0.3) / 2);
    expect(floor.territoryZones.length).toBe(4);
    for (const zone of floor.territoryZones) {
      expect(zone.radius).toBe(expectedRadius);
      const den = floor.roomGraph
        .getAll()
        .find((room) => room.role === RoomRole.BOSS_DEN && room.familyIndex === zone.familyIndex)!;
      const denCx = den.bounds.x + Math.floor(den.bounds.width / 2);
      const denCy = den.bounds.y + Math.floor(den.bounds.height / 2);
      expect(zone.centerX).toBe(denCx);
      expect(zone.centerY).toBe(denCy);
    }
  });

  it('keeps den centers within configured radial band and minimum separation', () => {
    const minFrac = 0.6;
    const maxFrac = 0.8;
    const minSeparation = 28;
    const floor = new CaveSystemGenerator({ presentCount: 4 }).generate(
      {
        ...smallConfig(44, 200, 160),
        caveSystem: {
          denTargetRadiusMinFraction: minFrac,
          denTargetRadiusMaxFraction: maxFrac,
          denTargetMinSeparationTiles: minSeparation,
        },
      },
      new SeededRandom(44),
    );
    const heart = floor.roomGraph.getAll().find((room) => room.role === RoomRole.RESOURCE_HEART)!;
    const heartCx = heart.bounds.x + Math.floor(heart.bounds.width / 2);
    const heartCy = heart.bounds.y + Math.floor(heart.bounds.height / 2);
    const maxEdgeDistance = Math.min(
      heartCx - 2,
      floor.width - 3 - heartCx,
      heartCy - 2,
      floor.height - 3 - heartCy,
    );
    const minExpected = Math.floor(maxEdgeDistance * minFrac);
    const maxExpected = Math.floor(maxEdgeDistance * maxFrac);
    const zones = floor.territoryZones;
    for (const zone of zones) {
      const distance = Math.hypot(zone.centerX - heartCx, zone.centerY - heartCy);
      expect(distance).toBeGreaterThanOrEqual(minExpected - 1);
      expect(distance).toBeLessThanOrEqual(maxExpected + 3);
    }
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const distance = Math.hypot(
          zones[i]!.centerX - zones[j]!.centerX,
          zones[i]!.centerY - zones[j]!.centerY,
        );
        expect(distance).toBeGreaterThanOrEqual(minSeparation);
      }
    }
  });

  it('applies configurable territory radius fraction', () => {
    const floor = new CaveSystemGenerator({ presentCount: 4 }).generate(
      {
        ...smallConfig(63, 200, 200),
        caveSystem: {
          territoryRadiusFraction: 0.5,
        },
      },
      new SeededRandom(63),
    );
    const expectedRadius = Math.floor(Math.round(Math.min(200, 200) * 0.5) / 2);
    expect(floor.territoryZones.length).toBe(4);
    for (const zone of floor.territoryZones) {
      expect(zone.radius).toBe(expectedRadius);
    }
  });

  it('carves boss dens with full wall perimeters and exactly two adjacent doors', () => {
    const floor = generateWithPresent(77, 4, 120, 90);
    const dens = floor.roomGraph.getAll().filter((room) => room.role === RoomRole.BOSS_DEN);
    expect(dens.length).toBe(4);
    for (const den of dens) {
      expect(den.doors.length).toBe(2);
      const [doorA, doorB] = den.doors;
      expect(Math.abs(doorA!.x - doorB!.x) + Math.abs(doorA!.y - doorB!.y)).toBe(1);
      const doorSet = new Set(den.doors.map((door) => `${door.x},${door.y}`));
      const bx0 = den.bounds.x;
      const by0 = den.bounds.y;
      const bx1 = den.bounds.x + den.bounds.width - 1;
      const by1 = den.bounds.y + den.bounds.height - 1;
      for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
          const perimeter = x === bx0 || x === bx1 || y === by0 || y === by1;
          if (!perimeter) continue;
          const idx = y * floor.width + x;
          const isDoor = doorSet.has(`${x},${y}`);
          if (isDoor) {
            expect(floor.terrain[idx]).toBe(TerrainType.DOOR);
          } else {
            expect(floor.terrain[idx]).toBe(TerrainType.STONE_WALL);
            expect(floor.tileMap.isPassable(x, y)).toBe(false);
          }
        }
      }
    }
  });

  it('carves settlement rooms and inter-room hallways with wall perimeters', () => {
    const floor = generateWithPresent(77, 4, 120, 90);
    const settlements = floor.roomGraph
      .getAll()
      .filter((room) => room.role === RoomRole.SETTLEMENT);
    expect(settlements.length).toBeGreaterThanOrEqual(2);

    const roomByLabel = new Map(settlements.map((room) => [room.label, room] as const));
    const bar = roomByLabel.get('settlement_bar');
    expect(bar).toBeDefined();

    for (const room of settlements) {
      const doorSet = new Set(room.doors.map((door) => `${door.x},${door.y}`));
      const x0 = room.bounds.x;
      const y0 = room.bounds.y;
      const x1 = room.bounds.x + room.bounds.width - 1;
      const y1 = room.bounds.y + room.bounds.height - 1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const perimeter = x === x0 || x === x1 || y === y0 || y === y1;
          if (!perimeter) continue;
          const idx = y * floor.width + x;
          const isDoor = doorSet.has(`${x},${y}`);
          if (isDoor) {
            expect(floor.terrain[idx]).toBe(TerrainType.DOOR);
          } else {
            expect(floor.terrain[idx]).toBe(TerrainType.STONE_WALL);
            expect(floor.tileMap.isPassable(x, y)).toBe(false);
          }
        }
      }
    }

    const barRoom = bar!;
    const annexRooms = settlements.filter((room) => room.id !== barRoom.id);
    for (const annex of annexRooms) {
      const annexDoorX =
        annex.bounds.x < barRoom.bounds.x
          ? annex.bounds.x + annex.bounds.width - 1
          : annex.bounds.x;
      const barDoorX =
        annex.bounds.x < barRoom.bounds.x
          ? barRoom.bounds.x
          : barRoom.bounds.x + barRoom.bounds.width - 1;
      const annexDoor = annex.doors.find((door) => door.x === annexDoorX);
      const barDoor = barRoom.doors.find((door) => door.x === barDoorX && door.y === annexDoor?.y);
      expect(annexDoor, `${annex.label} missing hallway-facing door`).toBeDefined();
      expect(barDoor, `settlement_bar missing door to ${annex.label}`).toBeDefined();
      const y = annexDoor!.y;
      const startX = Math.min(annexDoor!.x, barDoor!.x);
      const endX = Math.max(annexDoor!.x, barDoor!.x);
      for (let x = startX; x <= endX; x++) {
        const idx = y * floor.width + x;
        expect(floor.tileMap.isPassable(x, y), `hallway floor blocked at (${x},${y})`).toBe(true);
        if (floor.terrain[idx] !== TerrainType.DOOR) {
          expect(floor.terrain[idx]).toBe(TerrainType.STONE_FLOOR);
        }
        for (const sideY of [y - 1, y + 1]) {
          const sideIdx = sideY * floor.width + x;
          const isSideDoor = settlements.some((room) =>
            room.doors.some((door) => door.x === x && door.y === sideY),
          );
          if (isSideDoor) continue;
          expect(floor.terrain[sideIdx]).toBe(TerrainType.STONE_WALL);
          expect(floor.tileMap.isPassable(x, sideY)).toBe(false);
        }
      }
    }
  });

  it('keeps SPAWN room perimeter sealed across representative seeds', () => {
    for (const seed of [7, 11, 23, 42, 89, 123]) {
      const floor = generateWithPresent(seed, 4, 120, 90);
      const rooms = floor.roomGraph.getAll();
      const spawnRoom = rooms.find((room) => room.role === RoomRole.SPAWN);
      expect(spawnRoom).toBeDefined();
      expectRoomPerimeterSealed(floor, spawnRoom!, seed);
    }
  });

  it('enforces configurable spawn and settlement minimum distances from key rooms', () => {
    const floor = new CaveSystemGenerator({ presentCount: 4 }).generate(
      {
        ...smallConfig(91, 200, 200),
        caveSystem: {
          spawnMinDistanceFromDenTiles: 28,
          spawnMinDistanceFromResourceHeartTiles: 30,
          spawnMinDistanceFromSettlementTiles: 26,
          settlementMinDistanceFromDenTiles: 24,
          settlementMinDistanceFromResourceHeartTiles: 18,
        },
      },
      new SeededRandom(91),
    );
    const rooms = floor.roomGraph.getAll();
    const spawn = rooms.find((room) => room.role === RoomRole.SPAWN)!;
    const settlementBar = rooms.find(
      (room) => room.role === RoomRole.SETTLEMENT && room.label === 'settlement_bar',
    )!;
    const heart = rooms.find((room) => room.role === RoomRole.RESOURCE_HEART)!;
    const denCenters = rooms
      .filter((room) => room.role === RoomRole.BOSS_DEN)
      .map((room) => ({
        x: room.bounds.x + Math.floor(room.bounds.width / 2),
        y: room.bounds.y + Math.floor(room.bounds.height / 2),
      }));

    const spawnCenterX = spawn.bounds.x + Math.floor(spawn.bounds.width / 2);
    const spawnCenterY = spawn.bounds.y + Math.floor(spawn.bounds.height / 2);
    const settlementCenterX = settlementBar.bounds.x + Math.floor(settlementBar.bounds.width / 2);
    const settlementCenterY = settlementBar.bounds.y + Math.floor(settlementBar.bounds.height / 2);
    const heartCenterX = heart.bounds.x + Math.floor(heart.bounds.width / 2);
    const heartCenterY = heart.bounds.y + Math.floor(heart.bounds.height / 2);

    const closestSpawnToDen = Math.min(
      ...denCenters.map((den) => Math.hypot(spawnCenterX - den.x, spawnCenterY - den.y)),
    );
    expect(closestSpawnToDen).toBeGreaterThanOrEqual(28);
    expect(
      Math.hypot(spawnCenterX - heartCenterX, spawnCenterY - heartCenterY),
    ).toBeGreaterThanOrEqual(30);
    expect(
      Math.hypot(spawnCenterX - settlementCenterX, spawnCenterY - settlementCenterY),
    ).toBeGreaterThanOrEqual(26);

    const closestSettlementToDen = Math.min(
      ...denCenters.map((den) => Math.hypot(settlementCenterX - den.x, settlementCenterY - den.y)),
    );
    expect(closestSettlementToDen).toBeGreaterThanOrEqual(24);
    expect(
      Math.hypot(settlementCenterX - heartCenterX, settlementCenterY - heartCenterY),
    ).toBeGreaterThanOrEqual(18);
  });

  it('supports den placement jitter while staying deterministic', () => {
    const baseConfig: MapConfig = {
      ...smallConfig(112, 200, 200),
      caveSystem: {
        denStartAngleJitterFraction: 0,
        denDistanceJitterFraction: 0,
      },
    };
    const jitterConfig: MapConfig = {
      ...smallConfig(112, 200, 200),
      caveSystem: {
        denStartAngleJitterFraction: 0.75,
        denDistanceJitterFraction: 0.65,
      },
    };
    const generator = new CaveSystemGenerator({ presentCount: 4 });
    const base = generator.generate(baseConfig, new SeededRandom(112));
    const a = generator.generate(jitterConfig, new SeededRandom(112));
    const b = generator.generate(jitterConfig, new SeededRandom(112));
    const baseCenters = base.territoryZones.map((zone) => [zone.centerX, zone.centerY]);
    const aCenters = a.territoryZones.map((zone) => [zone.centerX, zone.centerY]);
    const bCenters = b.territoryZones.map((zone) => [zone.centerX, zone.centerY]);
    expect(aCenters).toEqual(bCenters);
    expect(aCenters).not.toEqual(baseCenters);
    // Heavy: three 200×200 cave-gen determinism runs. Generous timeout so the
    // full parallel verify suite's CPU/memory contention on constrained machines
    // can't flake it (isolated ~all-file 92s; this run alone can exceed 120s under
    // load). A genuine hang still fails at the higher bound — correctness assertions
    // above are unchanged.
  }, 240_000);

  it('keeps special rooms and structures from overlapping each other', () => {
    const floor = new CaveSystemGenerator({ presentCount: 4 }).generate(
      {
        ...smallConfig(42, 200, 200),
        caveSystem: {
          bossDenSize: 10,
          resourceHeartDiameterTiles: 30,
          territoryRadiusFraction: 0.5,
          denTargetRadiusMinFraction: 0.5,
          denTargetRadiusMaxFraction: 0.66,
          denTargetMinSeparationTiles: 50,
          regionSeparationTiles: 50,
          settlementMinDistanceFromDenTiles: 30,
          settlementMinDistanceFromResourceHeartTiles: 20,
        },
      },
      new SeededRandom(42),
    );

    const structureRoles = new Set([
      RoomRole.RESOURCE_HEART,
      RoomRole.BOSS_DEN,
      RoomRole.SETTLEMENT,
      RoomRole.SPAWN,
    ]);
    const structures = floor.roomGraph.getAll().filter((room) => structureRoles.has(room.role));

    const overlaps = (a: (typeof structures)[number], b: (typeof structures)[number]) =>
      a.bounds.x < b.bounds.x + b.bounds.width &&
      a.bounds.x + a.bounds.width > b.bounds.x &&
      a.bounds.y < b.bounds.y + b.bounds.height &&
      a.bounds.y + a.bounds.height > b.bounds.y;

    for (let i = 0; i < structures.length; i++) {
      for (let j = i + 1; j < structures.length; j++) {
        expect(
          overlaps(structures[i]!, structures[j]!),
          `${structures[i]!.role} overlaps ${structures[j]!.role}`,
        ).toBe(false);
      }
    }
  });

  it('RoomGraph.getRoomAt reports -1 for a wall tile inside a cave region bbox', () => {
    const floor = generateWithPresent(1, 4);
    const room = floor.roomGraph.getAll().find((r) => r.role === RoomRole.TERRITORY)!;
    let checked = 0;
    for (let ty = room.bounds.y; ty < room.bounds.y + room.bounds.height && checked < 5; ty++) {
      for (let tx = room.bounds.x; tx < room.bounds.x + room.bounds.width && checked < 5; tx++) {
        if (!floor.tileMap.isPassable(tx, ty)) {
          expect(floor.roomGraph.getRoomAt(tx, ty)).toBe(-1);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
