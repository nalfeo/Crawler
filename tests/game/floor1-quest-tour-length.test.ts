import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../../src/core/world.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import { generatedEquipmentRunKeyFromSeed } from '../../src/shared/generated-equipment-types.js';
import { TileFlags } from '../../src/shared/map-types.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';

/**
 * Deterministic guard on Floor 1 quest travel.
 *
 * The AI headless runner used to time out on a handful of seeds not because it
 * got stuck but because the *required* quest tour was simply too long: objective
 * placement deliberately maximized distance (fetch item in the farthest room —
 * on a doubled round trip — and the slime-rat room in the most isolated room on
 * the map, typically opposite the boss staircase). Those runs walked continuously
 * at 92–97% travel efficiency and still overshot the 330 s budget.
 *
 * This test locks in the bounded placement rules by measuring the actual tour a
 * player must walk, so a future placement change that re-inflates the route
 * fails here instead of silently eating the win-rate margin.
 */

interface Pt {
  readonly x: number;
  readonly y: number;
}

/**
 * Door-aware BFS tile distance. Doors are impassable to the default pathfinder
 * (they are gated by quest locks), but the player does walk through them, so the
 * geometric tour must treat them as traversable.
 */
function tileDistance(floorMap: FloorMap, a: Pt, b: Pt): number {
  const w = floorMap.width;
  const h = floorMap.height;
  const flags = floorMap.tileMap.flags;
  const walkable = (idx: number): boolean => {
    const f = flags[idx]!;
    return (f & TileFlags.PASSABLE) !== 0 || (f & TileFlags.DOOR) !== 0;
  };
  const start = a.y * w + a.x;
  const goal = b.y * w + b.x;
  if (!walkable(start) || !walkable(goal)) return Number.NaN;
  const dist = new Int32Array(w * h).fill(-1);
  dist[start] = 0;
  const queue: number[] = [start];
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++]!;
    if (idx === goal) return dist[idx]!;
    const cx = idx % w;
    const cy = (idx - cx) / w;
    const neighbors: readonly [number, number][] = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (dist[n] !== -1 || !walkable(n)) continue;
      dist[n] = dist[idx]! + 1;
      queue.push(n);
    }
  }
  return Number.NaN;
}

/**
 * Total tiles the player must walk to complete every Floor 1 quest, following
 * the canonical quest order: welcome → spell broker → shop → fetch item → back
 * to the shop → slime-rat room → boss staircase.
 */
function questTourTiles(seed: number): number {
  const world = createGameWorld({
    seed,
    generatedEquipmentRunKey: generatedEquipmentRunKeyFromSeed(seed),
  });
  const playerEid = spawnPlayer(world, 400, 400);
  getScenarioDefinition('floor1').configureWorld(world, playerEid);
  const floorMap = world.floorMap;
  expect(floorMap).toBeDefined();
  const objective = world.floorScenario?.objective;
  expect(objective).toBeDefined();
  const toTile = (p: Pt): Pt => floorMap!.worldToTile(p.x, p.y);

  const legs: readonly [Pt, Pt][] = [
    [floorMap!.playerSpawn, toTile(objective!.welcomeOfficePos)],
    [toTile(objective!.welcomeOfficePos), toTile(objective!.spellQuestGiverPos)],
    [toTile(objective!.spellQuestGiverPos), toTile(objective!.shopRoomPos)],
    [toTile(objective!.shopRoomPos), toTile(objective!.questItemPos)],
    [toTile(objective!.questItemPos), toTile(objective!.shopRoomPos)],
    [toTile(objective!.shopRoomPos), toTile(objective!.slimeRatRoomPos)],
    [toTile(objective!.slimeRatRoomPos), toTile(objective!.staircasePos)],
  ];
  let total = 0;
  for (const [from, to] of legs) {
    const d = tileDistance(floorMap!, from, to);
    expect(Number.isNaN(d), `unreachable quest leg on seed ${seed}`).toBe(false);
    total += d;
  }
  return total;
}

// Measured over seeds 1–100 with the fetch item bounded to a hop band around the
// shop: median 1068, p90 1372, p95 1497, max 1761 tiles (down from median 1252 /
// p90 1548 / max 1950 when the item was placed in the room farthest from spawn).
// The doubled shop errand — the leg most worth bounding, since every tile is
// walked twice — dropped from a 550-tile round trip to 332 at the median.
// Thresholds sit above the measured distribution with headroom for ordinary
// generator churn, so they catch a re-inflation of the route rather than normal
// seed-to-seed variation.
const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const MAX_MEDIAN_TOUR_TILES = 1250;
const MAX_TOUR_TILES = 1900;

describe('Floor 1 quest tour length', () => {
  it('keeps the required quest tour bounded across a seed prefix', () => {
    const tours = SEEDS.map((seed) => ({ seed, tiles: questTourTiles(seed) }));
    for (const { seed, tiles } of tours) {
      expect(tiles, `seed ${seed} quest tour is ${tiles} tiles`).toBeLessThanOrEqual(
        MAX_TOUR_TILES,
      );
    }
    const sorted = tours.map((t) => t.tiles).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    expect(median).toBeLessThanOrEqual(MAX_MEDIAN_TOUR_TILES);
  });

  it('does not send the player on a map-diameter round trip for the fetch item', () => {
    // The shop errand is walked twice, so it is the leg most worth bounding.
    for (const seed of SEEDS.slice(0, 12)) {
      const world = createGameWorld({
        seed,
        generatedEquipmentRunKey: generatedEquipmentRunKeyFromSeed(seed),
      });
      const playerEid = spawnPlayer(world, 400, 400);
      getScenarioDefinition('floor1').configureWorld(world, playerEid);
      const floorMap = world.floorMap!;
      const objective = world.floorScenario!.objective;
      const shop = floorMap.worldToTile(objective.shopRoomPos.x, objective.shopRoomPos.y);
      const item = floorMap.worldToTile(objective.questItemPos.x, objective.questItemPos.y);
      const roundTrip = 2 * tileDistance(floorMap, shop, item);
      expect(roundTrip, `seed ${seed} fetch round trip is ${roundTrip} tiles`).toBeLessThanOrEqual(
        1000,
      );
    }
  });
});
