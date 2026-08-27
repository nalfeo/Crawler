/**
 * Floor 4 slice 1 — the authored broadcast venue and its floor plumbing.
 *
 * The geometry assertions here are deliberately exact rather than "looks
 * roughly right": wave manifests will name feed gates by index (spec FR3.4), so
 * a silently-shifted gate is a data-contract break, not a cosmetic one.
 */
import { describe, expect, it } from 'vitest';
import {
  ShowcaseArenaGenerator,
  computeShowcaseArenaLayout,
} from '../../src/core/map/generators/ShowcaseArenaGenerator';
import { getGenerator } from '../../src/core/map/generators/registry';
import type { FloorMap } from '../../src/core/map/FloorMap';
import { BiomeType, type MapConfig, type RoomBounds } from '../../src/shared/map-types';
import { SeededRandom } from '../../src/shared/random';
import { getFloorManifest, getImplementedFloorIds } from '../../src/shared/floor-registry';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions';
import { floor4Manifest } from '../../src/shared/floor-manifest.js';

function floor4Config(overrides: Partial<MapConfig> = {}): MapConfig {
  const geometry = floor4Manifest.floor4;
  return {
    widthTiles: floor4Manifest.map.widthTiles,
    heightTiles: floor4Manifest.map.heightTiles,
    tileSizeFt: floor4Manifest.map.tileSizeFt,
    biome: floor4Manifest.map.biome ?? BiomeType.SHOWCASE_ARENA,
    seed: floor4Manifest.map.seed,
    roomWidthRange: floor4Manifest.map.roomWidthRange,
    roomHeightRange: floor4Manifest.map.roomHeightRange,
    maxRooms: floor4Manifest.map.maxRooms,
    floorDensity: floor4Manifest.map.floorDensity,
    showcaseArena: geometry
      ? {
          arenaWidthTiles: geometry.arena.widthTiles,
          arenaHeightTiles: geometry.arena.heightTiles,
          greenRoomWidthTiles: geometry.greenRoom.widthTiles,
          greenRoomHeightTiles: geometry.greenRoom.heightTiles,
          tunnelLengthTiles: geometry.tunnel.lengthTiles,
          tunnelWidthTiles: geometry.tunnel.widthTiles,
          pillarSizeTiles: geometry.arena.pillarSizeTiles,
          pillarInsetTiles: geometry.arena.pillarInsetTiles,
          borderThicknessTiles: geometry.arena.borderThicknessTiles,
        }
      : undefined,
    ...overrides,
  };
}

// Passability is asserted through `tileMap.isPassable` (tile coords); the
// FloorMap wrapper takes feet, which would silently read the wrong tile here.
function generate(config: MapConfig = floor4Config(), seed = 1): FloorMap {
  return new ShowcaseArenaGenerator().generate(config, new SeededRandom(seed));
}

/** SeededRandom proxy that counts every draw, to prove the venue is authored. */
function countingRng(seed: number): { rng: SeededRandom; draws: () => number } {
  const inner = new SeededRandom(seed);
  let calls = 0;
  const rng = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          calls += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as SeededRandom;
  return { rng, draws: () => calls };
}

function contains(rect: RoomBounds, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

describe('computeShowcaseArenaLayout', () => {
  it('publishes feed gates in the documented index order (0=N, 1=E, 2=S, 3=W)', () => {
    const layout = computeShowcaseArenaLayout();
    expect(layout.feedGates.map((g) => g.index)).toEqual([0, 1, 2, 3]);
    expect(layout.feedGates.map((g) => g.direction)).toEqual(['north', 'east', 'south', 'west']);
  });

  it('places each gate on the matching arena wall', () => {
    const { arena, feedGates } = computeShowcaseArenaLayout();
    const [north, east, south, west] = feedGates;
    expect(north?.y).toBe(arena.y);
    expect(south?.y).toBe(arena.y + arena.height - 1);
    expect(west?.x).toBe(arena.x);
    expect(east?.x).toBe(arena.x + arena.width - 1);
  });

  it('spawns the player at the arena centre, clear of every pit fixture', () => {
    const layout = computeShowcaseArenaLayout();
    expect(contains(layout.arena, layout.playerSpawn.x, layout.playerSpawn.y)).toBe(true);
    for (const pillar of layout.pillars) {
      expect(contains(pillar, layout.playerSpawn.x, layout.playerSpawn.y)).toBe(false);
    }
  });

  it('keeps the curtain tunnel clear of the east feed gate', () => {
    const { tunnel, feedGates } = computeShowcaseArenaLayout();
    const east = feedGates[1]!;
    expect(east.y < tunnel.y || east.y >= tunnel.y + tunnel.height).toBe(true);
  });

  it('throws rather than clamping when pit fixtures would meet mid-arena', () => {
    // Clamping would silently move gate tiles, invalidating seeded wave data.
    expect(() => computeShowcaseArenaLayout({ pillarInsetTiles: 19 })).toThrow(
      /meet in the middle/,
    );
  });

  it('throws when the Green Room cannot fit inside the venue border', () => {
    expect(() => computeShowcaseArenaLayout({ greenRoomHeightTiles: 80 })).toThrow(/does not fit/);
  });

  it('throws when the curtain tunnel is wider than the Green Room it opens into', () => {
    expect(() =>
      computeShowcaseArenaLayout({ tunnelWidthTiles: 15, greenRoomHeightTiles: 6 }),
    ).toThrow(/wider than the Green Room/);
  });

  it('rejects non-integer and non-positive geometry', () => {
    expect(() => computeShowcaseArenaLayout({ tunnelLengthTiles: 0 })).toThrow(/positive integer/);
    expect(() => computeShowcaseArenaLayout({ arenaWidthTiles: 33.5 })).toThrow(/positive integer/);
  });
});

describe('ShowcaseArenaGenerator', () => {
  it('is registered for the showcase_arena biome', () => {
    expect(getGenerator(BiomeType.SHOWCASE_ARENA).name).toBe('ShowcaseArenaGenerator');
  });

  it('consumes zero RNG draws', () => {
    const { rng, draws } = countingRng(12345);
    new ShowcaseArenaGenerator().generate(floor4Config(), rng);
    expect(draws()).toBe(0);
  });

  it('produces byte-identical geometry for different seeds', () => {
    const a = generate(floor4Config({ seed: 1 }), 1);
    const b = generate(floor4Config({ seed: 999_999 }), 999_999);
    expect(Array.from(b.flags)).toEqual(Array.from(a.flags));
    expect(b.playerSpawn).toEqual(a.playerSpawn);
  });

  it('carves a passable arena, tunnel and Green Room and solid pit fixtures', () => {
    const map = generate();
    const layout = computeShowcaseArenaLayout(floor4Config().showcaseArena);
    for (const rect of [layout.arena, layout.tunnel, layout.greenRoom]) {
      const solid: string[] = [];
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        for (let x = rect.x; x < rect.x + rect.width; x += 1) {
          const inPillar = layout.pillars.some((p) => contains(p, x, y));
          if (!inPillar && !map.tileMap.isPassable(x, y)) solid.push(`${x},${y}`);
        }
      }
      expect(solid).toEqual([]);
    }
    for (const pillar of layout.pillars) {
      expect(map.tileMap.isPassable(pillar.x, pillar.y)).toBe(false);
    }
  });

  it('leaves every feed gate tile passable so waves can actually enter', () => {
    const map = generate();
    expect(map.feedGates).toHaveLength(4);
    for (const gate of map.feedGates) {
      expect(map.tileMap.isPassable(gate.x, gate.y)).toBe(true);
    }
  });

  it('lets the player walk from the arena spawn into the Green Room', () => {
    // Slice 1's acceptance criterion. The tunnel is intentionally OPEN here;
    // FR9.4 sealing is the slice-5 intermission transaction.
    const map = generate();
    const layout = computeShowcaseArenaLayout(floor4Config().showcaseArena);
    const target = {
      x: layout.greenRoom.x + Math.floor(layout.greenRoom.width / 2),
      y: layout.greenRoom.y + Math.floor(layout.greenRoom.height / 2),
    };
    const width = map.config.widthTiles;
    const seen = new Set<number>();
    const queue = [map.playerSpawn];
    seen.add(map.playerSpawn.y * width + map.playerSpawn.x);
    let reached = false;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.x === target.x && cur.y === target.y) {
        reached = true;
        break;
      }
      for (const [dx, dy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const key = ny * width + nx;
        if (seen.has(key) || !map.tileMap.isPassable(nx, ny)) continue;
        seen.add(key);
        queue.push({ x: nx, y: ny });
      }
    }
    expect(reached).toBe(true);
  });

  it('keeps the arena kitable: no passable tile is a dead end', () => {
    // A one-exit pocket in an arena floor is a stuck-player trap, and Floor 4's
    // whole combat premise is movement (spec FR4).
    const map = generate();
    const layout = computeShowcaseArenaLayout(floor4Config().showcaseArena);
    const deadEnds: string[] = [];
    for (let y = layout.arena.y; y < layout.arena.y + layout.arena.height; y += 1) {
      for (let x = layout.arena.x; x < layout.arena.x + layout.arena.width; x += 1) {
        if (!map.tileMap.isPassable(x, y)) continue;
        const exits = [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ].filter(([dx, dy]) => map.tileMap.isPassable(x + dx!, y + dy!)).length;
        if (exits < 2) deadEnds.push(`${x},${y}`);
      }
    }
    expect(deadEnds).toEqual([]);
  });

  it('labels the arena as the spawn room and the Green Room as safe', () => {
    const map = generate();
    const arena = map.rooms.find((r) => r.label === 'the-pit');
    const greenRoom = map.rooms.find((r) => r.label === 'green-room');
    expect(arena?.neighbors).toContain(greenRoom!.id);
    expect(greenRoom?.neighbors).toContain(arena!.id);
    expect(arena?.role).toBe('spawn');
    expect(greenRoom?.role).toBe('safe');
  });

  it('refuses a map smaller than the authored venue', () => {
    expect(() => generate(floor4Config({ widthTiles: 40, heightTiles: 20 }))).toThrow(
      /authored venue needs at least/,
    );
  });
});

describe('floor4 plumbing', () => {
  const manifest = getFloorManifest('floor4');

  it('is registered with the showcase_arena biome', () => {
    expect(manifest?.map.biome).toBe(BiomeType.SHOWCASE_ARENA);
  });

  it('declares a win budget without claiming to be playable yet', () => {
    // FR8.5 budget is a property of the design, not of how far the build got,
    // so it is authored now even though the floor is unimplemented.
    expect(manifest?.implemented.mvp).toBe(false);
    expect(manifest?.implemented.winBudgetMs).toBe(900_000);
    expect(getImplementedFloorIds()).not.toContain('floor4');
  });

  it('keeps the stall backstop distinct from the win budget', () => {
    expect(manifest?.timer?.durationMs).not.toBe(manifest?.implemented.winBudgetMs);
  });

  it('declares no ambient enemy pack, because its waves are authored', () => {
    expect(manifest?.enemyPackId).toBeUndefined();
  });

  it('has a registered scenario whose stairs stay barred', () => {
    const scenario = getScenarioDefinition('floor4');
    expect(scenario.floorId).toBe('floor4');
    // FR8.3 gates descent on INTERMISSION(5), which does not exist yet.
    expect(scenario.onStairDescend?.({} as never, 0)).toBe(false);
    expect(scenario.nextFloorId).toBeUndefined();
  });

  it('builds a map config big enough for the manifest geometry', () => {
    const config = floor4Config();
    const layout = computeShowcaseArenaLayout(config.showcaseArena);
    expect(config.widthTiles).toBeGreaterThanOrEqual(layout.widthTiles);
    expect(config.heightTiles).toBeGreaterThanOrEqual(layout.heightTiles);
  });
});
