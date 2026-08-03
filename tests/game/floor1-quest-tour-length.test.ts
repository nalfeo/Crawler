import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import { buildInitiallyLockedDoorTileSet } from '../../src/game/floorScenario.js';
import { TileFlags } from '../../src/shared/map-types.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import { createTestWorld } from '../helpers/world-factory.js';

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
  const world = createTestWorld({ seed });
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

/**
 * Tile travel distances from `start`, walking passable tiles plus doors that are
 * not in `blockedDoorTiles`. `-1` means unreachable. Mirrors the reachability
 * model the placement rule is scored against: the boss-staircase and slime-rat
 * rooms are locked when the merchant issues the errand, so the fetch item has to
 * be reachable with those doors shut.
 */
function lockedAwareDistances(
  floorMap: FloorMap,
  start: Pt,
  blockedDoorTiles: ReadonlySet<string>,
): Int32Array {
  const w = floorMap.width;
  const h = floorMap.height;
  const dist = new Int32Array(w * h).fill(-1);
  const startIndex = start.y * w + start.x;
  dist[startIndex] = 0;
  const queue: number[] = [startIndex];
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++]!;
    const cx = idx % w;
    const cy = (idx - cx) / w;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as readonly [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (dist[n] !== -1) continue;
      const isDoor = floorMap.tileMap.isDoor(nx, ny);
      if (
        !floorMap.tileMap.isPassable(nx, ny) &&
        (!isDoor || blockedDoorTiles.has(`${nx},${ny}`))
      ) {
        continue;
      }
      dist[n] = dist[idx]! + 1;
      queue.push(n);
    }
  }
  return dist;
}

interface FetchPlacement {
  /** Walk from the merchant to the fetch item, with locked doors shut. */
  readonly distance: number;
  /** Longest such walk available to any room on the floor. */
  readonly maxDistance: number;
  /** Walk from the player spawn to the fetch item, with locked doors shut. */
  readonly spawnDistance: number;
}

function fetchPlacement(seed: number): FetchPlacement {
  const world = createTestWorld({ seed });
  const playerEid = spawnPlayer(world, 400, 400);
  getScenarioDefinition('floor1').configureWorld(world, playerEid);
  const floorMap = world.floorMap!;
  const objective = world.floorScenario!.objective;
  const toTile = (p: Pt): Pt => floorMap.worldToTile(p.x, p.y);
  const locked = buildInitiallyLockedDoorTileSet(floorMap, [
    objective.staircasePos,
    objective.slimeRatRoomPos,
  ]);
  // `shopRoomPos` tracks the shopkeeper's actual spawned tile, which is the
  // point the errand is issued from and returned to.
  const fromMerchant = lockedAwareDistances(floorMap, toTile(objective.shopRoomPos), locked);
  const fromSpawn = lockedAwareDistances(floorMap, floorMap.playerSpawn, locked);
  const item = toTile(objective.questItemPos);
  const itemIndex = item.y * floorMap.width + item.x;
  let maxDistance = 0;
  for (const room of floorMap.rooms) {
    const cx = Math.floor(room.bounds.x + room.bounds.width / 2);
    const cy = Math.floor(room.bounds.y + room.bounds.height / 2);
    maxDistance = Math.max(maxDistance, fromMerchant[cy * floorMap.width + cx]!);
  }
  return {
    distance: fromMerchant[itemIndex]!,
    maxDistance,
    spawnDistance: fromSpawn[itemIndex]!,
  };
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

  it('places the rat tail in a room that is actually reachable when the errand is issued', () => {
    // The boss-staircase and slime-rat rooms start locked. An item behind either
    // one makes the merchant errand unsatisfiable and the AI route planner
    // throws `unreachable-required-goal`.
    for (const seed of SEEDS) {
      const { distance, spawnDistance } = fetchPlacement(seed);
      expect(spawnDistance, `seed ${seed}: rat tail unreachable from spawn`).toBeGreaterThan(0);
      expect(distance, `seed ${seed}: rat tail unreachable from the merchant`).toBeGreaterThan(0);
    }
  });

  it('places the rat tail about two thirds of the way to the farthest reachable room', () => {
    // Measured over seeds 1–100: min 0.36, p25 0.65, median 0.67, p75 0.68,
    // max 0.85 of the longest merchant-anchored walk on the floor. The band is
    // wider than the observed spread because room granularity limits how close
    // any single seed can land to the 2/3 target; the median assertion is what
    // pins the rule itself.
    const fractions = SEEDS.map((seed) => {
      const { distance, maxDistance } = fetchPlacement(seed);
      expect(maxDistance, `seed ${seed}: no reachable rooms from the merchant`).toBeGreaterThan(0);
      const fraction = distance / maxDistance;
      expect(
        fraction,
        `seed ${seed} rat tail sits at ${fraction.toFixed(2)} of max`,
      ).toBeGreaterThan(0.3);
      expect(fraction, `seed ${seed} rat tail sits at ${fraction.toFixed(2)} of max`).toBeLessThan(
        0.9,
      );
      return fraction;
    }).sort((a, b) => a - b);
    const median = fractions[Math.floor(fractions.length / 2)]!;
    expect(median).toBeGreaterThan(0.6);
    expect(median).toBeLessThan(0.75);
  });

  it('does not send the player on a map-diameter round trip for the fetch item', () => {
    // The shop errand is walked twice, so it is the leg most worth bounding.
    for (const seed of SEEDS.slice(0, 12)) {
      const world = createTestWorld({ seed });
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
