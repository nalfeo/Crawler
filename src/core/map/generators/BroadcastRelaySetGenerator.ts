/**
 * BroadcastRelaySetGenerator — Floor 6's compact authored defense set.
 *
 * Geometry is deliberately fixed and consumes no RNG. Later systems may select
 * wave, route, reward, upgrade, dressing, and boss content from isolated seeded
 * streams without changing the map or consuming the world's shared combat RNG.
 */

import type { Floor6DefenseGeometry, Floor6Route } from '../../../shared/floor-types.js';
import type { MapConfig, RoomBounds } from '../../../shared/map-types.js';
import { RoomRole, TerrainType, TilePresets } from '../../../shared/map-types.js';
import type { SeededRandom } from '../../../shared/random.js';
import { FloorMap } from '../FloorMap.js';
import { RoomGraph } from '../RoomGraph.js';
import { TileMap } from '../TileMap.js';
import type { MapGenerator } from './types.js';

export interface BroadcastRelaySetOptions {
  readonly routeWidthTiles: number;
  readonly buildSiteSizeTiles: number;
  readonly borderThicknessTiles: number;
  readonly supportedFootprints: readonly {
    readonly id: string;
    readonly widthTiles: number;
    readonly heightTiles: number;
  }[];
}

export interface BroadcastRelaySetLayout extends Floor6DefenseGeometry {
  readonly widthTiles: number;
  readonly heightTiles: number;
}

const DEFAULT_OPTIONS: BroadcastRelaySetOptions = {
  routeWidthTiles: 5,
  buildSiteSizeTiles: 3,
  borderThicknessTiles: 2,
  supportedFootprints: [
    { id: 'standard', widthTiles: 1, heightTiles: 1 },
    { id: 'large', widthTiles: 2, heightTiles: 2 },
  ],
};

function requirePositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`BroadcastRelaySetGenerator: ${name} must be a positive integer, got ${value}`);
  }
}

function freezeBounds(bounds: RoomBounds): RoomBounds {
  return Object.freeze({ ...bounds });
}

function area(id: string, bounds: RoomBounds) {
  return Object.freeze({ id, bounds: freezeBounds(bounds) });
}

function route(
  id: string,
  entranceId: string,
  widthTiles: number,
  waypoints: readonly { readonly x: number; readonly y: number }[],
): Floor6Route {
  return Object.freeze({
    id,
    entranceId,
    widthTiles,
    waypoints: Object.freeze(waypoints.map((point) => Object.freeze({ ...point }))),
  });
}

/**
 * Produce the stable semantic geometry shared by runtime, labs, and tests.
 * IDs and ordering are append-only replay artifacts.
 */
export function computeBroadcastRelaySetLayout(
  options: Partial<BroadcastRelaySetOptions> = {},
): BroadcastRelaySetLayout {
  const opts: BroadcastRelaySetOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    supportedFootprints: options.supportedFootprints ?? DEFAULT_OPTIONS.supportedFootprints,
  };
  requirePositiveInt('routeWidthTiles', opts.routeWidthTiles);
  requirePositiveInt('buildSiteSizeTiles', opts.buildSiteSizeTiles);
  requirePositiveInt('borderThicknessTiles', opts.borderThicknessTiles);
  if (opts.routeWidthTiles % 2 === 0) {
    throw new Error('BroadcastRelaySetGenerator: route width must be odd');
  }
  if (
    opts.routeWidthTiles !== 5 ||
    opts.buildSiteSizeTiles !== 3 ||
    opts.borderThicknessTiles !== 2
  ) {
    throw new Error(
      'BroadcastRelaySetGenerator: Slice 2 supports only the authored 5-tile routes, 3-tile sites, and 2-tile border',
    );
  }

  const footprintIds = new Set<string>();
  const supportedFootprints = opts.supportedFootprints.map((footprint) => {
    requirePositiveInt(`supported footprint ${footprint.id} width`, footprint.widthTiles);
    requirePositiveInt(`supported footprint ${footprint.id} height`, footprint.heightTiles);
    if (!footprint.id || footprintIds.has(footprint.id)) {
      throw new Error(
        `BroadcastRelaySetGenerator: supported footprint ids must be non-empty and unique (${footprint.id})`,
      );
    }
    if (
      footprint.widthTiles > opts.routeWidthTiles ||
      footprint.heightTiles > opts.routeWidthTiles
    ) {
      throw new Error(
        `BroadcastRelaySetGenerator: footprint ${footprint.id} exceeds the authored route width`,
      );
    }
    footprintIds.add(footprint.id);
    return Object.freeze({ ...footprint });
  });

  const playerIngress = area('player-ingress', { x: 32, y: 38, width: 10, height: 8 });
  const broadcastRelay = Object.freeze({
    ...area('broadcast-relay', { x: 53, y: 18, width: 11, height: 13 }),
    target: Object.freeze({ x: 58, y: 24 }),
  });
  const westEntrance = Object.freeze({
    ...area('west-service-entrance', { x: 2, y: 10, width: 8, height: 9 }),
    spawn: Object.freeze({ x: 6, y: 14 }),
  });
  const southEntrance = Object.freeze({
    ...area('south-loading-entrance', { x: 20, y: 38, width: 9, height: 8 }),
    spawn: Object.freeze({ x: 24, y: 42 }),
  });
  const routes = Object.freeze([
    route('west-service-route', westEntrance.id, opts.routeWidthTiles, [
      westEntrance.spawn,
      { x: 48, y: 14 },
      { x: 48, y: 24 },
      broadcastRelay.target,
    ]),
    route('south-loading-route', southEntrance.id, opts.routeWidthTiles, [
      southEntrance.spawn,
      { x: 24, y: 32 },
      { x: 48, y: 32 },
      { x: 48, y: 24 },
      broadcastRelay.target,
    ]),
  ]);
  const siteSize = opts.buildSiteSizeTiles;
  const buildSites = Object.freeze([
    area('plinth-west-a', { x: 16, y: 9, width: siteSize, height: siteSize }),
    area('plinth-west-b', { x: 31, y: 17, width: siteSize, height: siteSize }),
    area('plinth-south-a', { x: 19, y: 30, width: siteSize, height: siteSize }),
    area('plinth-south-b', { x: 32, y: 27, width: siteSize, height: siteSize }),
    area('plinth-relay', { x: 43, y: 24, width: siteSize, height: siteSize }),
  ]);

  return Object.freeze({
    widthTiles: 72,
    heightTiles: 48,
    playerIngress,
    broadcastRelay,
    entrances: Object.freeze([westEntrance, southEntrance]),
    routes,
    buildSites,
    pickupAccess: area('pickup-access', { x: 46, y: 36, width: 8, height: 8 }),
    breakAccess: area('pickup-break-access', { x: 53, y: 38, width: 6, height: 3 }),
    breakEnclosure: area('break-enclosure', { x: 58, y: 35, width: 10, height: 9 }),
    victoryExit: area('victory-exit', { x: 66, y: 20, width: 4, height: 9 }),
    supportedFootprints: Object.freeze(supportedFootprints),
  });
}

export function broadcastRelaySetOptionsFromConfig(
  config: MapConfig,
): Partial<BroadcastRelaySetOptions> {
  const raw = config.broadcastRelaySet;
  if (!raw) return {};
  const entries = Object.entries(raw).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<BroadcastRelaySetOptions>;
}

function routeTiles(routeDef: Floor6Route): readonly { readonly x: number; readonly y: number }[] {
  const halfWidth = Math.floor(routeDef.widthTiles / 2);
  const keys = new Set<string>();
  const points: { x: number; y: number }[] = [];
  const add = (x: number, y: number): void => {
    const key = `${x},${y}`;
    if (keys.has(key)) return;
    keys.add(key);
    points.push({ x, y });
  };
  for (let index = 1; index < routeDef.waypoints.length; index += 1) {
    const from = routeDef.waypoints[index - 1]!;
    const to = routeDef.waypoints[index]!;
    if (from.x !== to.x && from.y !== to.y) {
      throw new Error(`BroadcastRelaySetGenerator: route ${routeDef.id} is not axis-aligned`);
    }
    if (from.y === to.y) {
      for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x += 1) {
        for (let offset = -halfWidth; offset <= halfWidth; offset += 1) {
          add(x, from.y + offset);
        }
      }
    } else {
      for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y += 1) {
        for (let offset = -halfWidth; offset <= halfWidth; offset += 1) {
          add(from.x + offset, y);
        }
      }
    }
  }
  return points;
}

/** Stable tile footprint reserved by every authored enemy route. */
export function _getBroadcastRelayRouteTiles(
  layout: BroadcastRelaySetLayout,
): readonly { readonly x: number; readonly y: number }[] {
  const seen = new Set<string>();
  const result: { x: number; y: number }[] = [];
  for (const routeDef of layout.routes) {
    for (const point of routeTiles(routeDef)) {
      const key = `${point.x},${point.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(point);
    }
  }
  return result;
}

export class BroadcastRelaySetGenerator implements MapGenerator {
  readonly name = 'BroadcastRelaySetGenerator';

  generate(config: MapConfig, _rng: SeededRandom): FloorMap {
    const layout = computeBroadcastRelaySetLayout(broadcastRelaySetOptionsFromConfig(config));
    const width = config.widthTiles;
    const height = config.heightTiles;
    if (width < layout.widthTiles || height < layout.heightTiles) {
      throw new Error(
        `BroadcastRelaySetGenerator: map is ${width}x${height} tiles but the authored set needs at least ${layout.widthTiles}x${layout.heightTiles}`,
      );
    }

    const tileMap = new TileMap(width, height);
    const terrain = new Uint8Array(width * height);
    tileMap.fill(TilePresets.WALL);
    terrain.fill(TerrainType.STONE_WALL);

    const carveTile = (x: number, y: number, terrainType: TerrainType): void => {
      tileMap.setFlags(x, y, TilePresets.FLOOR);
      terrain[y * width + x] = terrainType;
    };
    const carve = (bounds: RoomBounds, terrainType: TerrainType): void => {
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
          carveTile(x, y, terrainType);
        }
      }
    };

    for (const point of _getBroadcastRelayRouteTiles(layout)) {
      carveTile(point.x, point.y, TerrainType.CORRIDOR);
    }
    for (const entrance of layout.entrances) carve(entrance.bounds, TerrainType.DIRT);
    carve(layout.broadcastRelay.bounds, TerrainType.WOOD_FLOOR);
    carve(layout.playerIngress.bounds, TerrainType.STONE_FLOOR);
    carve(layout.pickupAccess.bounds, TerrainType.SAFE_ROOM_FLOOR);
    carve(layout.breakAccess.bounds, TerrainType.CORRIDOR);
    carve(layout.breakEnclosure.bounds, TerrainType.SAFE_ROOM_FLOOR);
    carve(layout.victoryExit.bounds, TerrainType.BOSS_STAIR_FLOOR);
    for (const site of layout.buildSites) carve(site.bounds, TerrainType.WOOD_FLOOR);

    // Player/pickup/exit access spurs are fixed and separate from enemy route
    // semantics, so future route selection cannot accidentally target them.
    carve({ x: 36, y: 32, width: 3, height: 7 }, TerrainType.CORRIDOR);
    carve({ x: 48, y: 32, width: 3, height: 5 }, TerrainType.CORRIDOR);
    carve({ x: 63, y: 23, width: 4, height: 3 }, TerrainType.CORRIDOR);

    const roomGraph = new RoomGraph();
    roomGraph.add(layout.playerIngress.bounds, [], [3], RoomRole.SPAWN, layout.playerIngress.id);
    roomGraph.add(
      layout.broadcastRelay.bounds,
      [],
      [2, 3, 4, 6],
      RoomRole.NORMAL,
      layout.broadcastRelay.id,
    );
    roomGraph.add(layout.entrances[0]!.bounds, [], [1], RoomRole.NORMAL, layout.entrances[0]!.id);
    roomGraph.add(
      layout.entrances[1]!.bounds,
      [],
      [0, 1],
      RoomRole.NORMAL,
      layout.entrances[1]!.id,
    );
    roomGraph.add(layout.pickupAccess.bounds, [], [1, 5], RoomRole.NORMAL, layout.pickupAccess.id);
    roomGraph.add(layout.breakEnclosure.bounds, [], [4], RoomRole.NORMAL, layout.breakEnclosure.id);
    roomGraph.add(layout.victoryExit.bounds, [], [1], RoomRole.NORMAL, layout.victoryExit.id);

    const spawn = {
      x: layout.playerIngress.bounds.x + Math.floor(layout.playerIngress.bounds.width / 2),
      y: layout.playerIngress.bounds.y + Math.floor(layout.playerIngress.bounds.height / 2),
    };
    return new FloorMap(config, tileMap, roomGraph, terrain, spawn);
  }
}
