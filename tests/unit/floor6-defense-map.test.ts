import { describe, expect, it } from 'vitest';
import {
  BroadcastRelaySetGenerator,
  computeBroadcastRelaySetLayout,
  _getBroadcastRelayRouteTiles,
} from '../../src/core/map/generators/BroadcastRelaySetGenerator.js';
import { getGenerator } from '../../src/core/map/generators/registry.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import { _buildFloor6MapConfig } from '../../src/game/floor6Scenario.js';
import { floor6Manifest } from '../../src/shared/floor-manifest.js';
import {
  getAvailableFloorIds,
  getFloorManifest,
  getImplementedFloorIds,
} from '../../src/shared/floor-registry.js';
import { BiomeType } from '../../src/shared/map-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { getScenarioDefinition, isFloorPlayable } from '../../src/game/scenarioDefinitions.js';

type Floor6TilePoint = { readonly x: number; readonly y: number };
type Floor6SupportedFootprint = {
  readonly id: string;
  readonly widthTiles: number;
  readonly heightTiles: number;
};

function generate(): FloorMap {
  const config = _buildFloor6MapConfig();
  return new BroadcastRelaySetGenerator().generate(config, new SeededRandom(606));
}

function tileKey(map: FloorMap, x: number, y: number): number {
  return y * map.config.widthTiles + x;
}

function footprintFits(
  map: FloorMap,
  point: Floor6TilePoint,
  footprint: Floor6SupportedFootprint,
  blocked: ReadonlySet<number>,
): boolean {
  for (let dy = 0; dy < footprint.heightTiles; dy += 1) {
    for (let dx = 0; dx < footprint.widthTiles; dx += 1) {
      const x = point.x + dx;
      const y = point.y + dy;
      if (!map.tileMap.isPassable(x, y) || blocked.has(tileKey(map, x, y))) return false;
    }
  }
  return true;
}

function canReach(
  map: FloorMap,
  start: Floor6TilePoint,
  target: Floor6TilePoint,
  footprint: Floor6SupportedFootprint,
  blocked: ReadonlySet<number> = new Set(),
): boolean {
  if (!footprintFits(map, start, footprint, blocked)) return false;
  const seen = new Set<number>([tileKey(map, start.x, start.y)]);
  const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (current.x === target.x && current.y === target.y) return true;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = tileKey(map, next.x, next.y);
      if (seen.has(key) || !footprintFits(map, next, footprint, blocked)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return false;
}

function centerOf(bounds: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): Floor6TilePoint {
  return {
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2),
  };
}

function siteBlockers(
  map: FloorMap,
  layout: ReturnType<typeof computeBroadcastRelaySetLayout>,
): Set<number> {
  const blocked = new Set<number>();
  for (const site of layout.buildSites) {
    for (let y = site.bounds.y; y < site.bounds.y + site.bounds.height; y += 1) {
      for (let x = site.bounds.x; x < site.bounds.x + site.bounds.width; x += 1) {
        blocked.add(tileKey(map, x, y));
      }
    }
  }
  return blocked;
}

describe('Floor 6 authored defense map', () => {
  it('registers the authored generator and consumes no RNG draws', () => {
    expect(getGenerator(BiomeType.BROADCAST_RELAY_SET).name).toBe('BroadcastRelaySetGenerator');
    const inner = new SeededRandom(123);
    let draws = 0;
    const rng = new Proxy(inner, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          draws += 1;
          return (value as (...parameters: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as SeededRandom;

    new BroadcastRelaySetGenerator().generate(_buildFloor6MapConfig(), rng);
    expect(draws).toBe(0);
  });

  it('keeps every authored route reachable to the Broadcast Relay for every supported footprint', () => {
    const map = generate();
    const layout = computeBroadcastRelaySetLayout(_buildFloor6MapConfig().broadcastRelaySet ?? {});
    for (const route of layout.routes) {
      const entrance = layout.entrances.find((candidate) => candidate.id === route.entranceId);
      expect(entrance, `missing entrance for ${route.id}`).toBeDefined();
      for (const footprint of layout.supportedFootprints) {
        expect(
          canReach(map, entrance!.spawn, layout.broadcastRelay.target, footprint),
          `${route.id} must reach the Relay for ${footprint.id}`,
        ).toBe(true);
      }
    }
  });

  it('authors legal non-overlapping sites that cannot block any supported route', () => {
    const map = generate();
    const layout = computeBroadcastRelaySetLayout(_buildFloor6MapConfig().broadcastRelaySet ?? {});
    const routeTiles = new Set(
      _getBroadcastRelayRouteTiles(layout).map((point) => tileKey(map, point.x, point.y)),
    );
    const blockedSites = new Set<number>();

    for (const site of layout.buildSites) {
      let touchesRoute = false;
      for (let y = site.bounds.y; y < site.bounds.y + site.bounds.height; y += 1) {
        for (let x = site.bounds.x; x < site.bounds.x + site.bounds.width; x += 1) {
          const key = tileKey(map, x, y);
          expect(map.tileMap.inBounds(x, y), `${site.id} must be in bounds`).toBe(true);
          expect(map.tileMap.isPassable(x, y), `${site.id} must be accessible`).toBe(true);
          expect(routeTiles.has(key), `${site.id} must stay off-route`).toBe(false);
          expect(blockedSites.has(key), `${site.id} must not overlap another site`).toBe(false);
          blockedSites.add(key);
          touchesRoute ||= (
            [
              [0, -1],
              [1, 0],
              [0, 1],
              [-1, 0],
            ] as const
          ).some(([dx, dy]) => routeTiles.has(tileKey(map, x + dx, y + dy)));
        }
      }
      expect(touchesRoute, `${site.id} must be reachable directly beside a route`).toBe(true);
    }

    for (const route of layout.routes) {
      const entrance = layout.entrances.find((candidate) => candidate.id === route.entranceId)!;
      for (const footprint of layout.supportedFootprints) {
        expect(
          canReach(map, entrance.spawn, layout.broadcastRelay.target, footprint, blockedSites),
          `${route.id} must remain open when every site is occupied for ${footprint.id}`,
        ).toBe(true);
      }
    }
  });

  it('keeps every player destination reachable for every supported footprint', () => {
    const map = generate();
    const layout = computeBroadcastRelaySetLayout(_buildFloor6MapConfig().broadcastRelaySet ?? {});
    const blockedSites = siteBlockers(map, layout);
    const destinations = [layout.pickupAccess, layout.breakEnclosure, layout.victoryExit] as const;

    for (const footprint of layout.supportedFootprints) {
      for (const destination of destinations) {
        expect(
          canReach(map, map.playerSpawn, centerOf(destination.bounds), footprint, blockedSites),
          `player ingress must reach ${destination.id} for ${footprint.id}`,
        ).toBe(true);
      }
    }
  });

  it('does not add a non-lane enemy entrance-to-Relay route', () => {
    const map = generate();
    const layout = computeBroadcastRelaySetLayout(_buildFloor6MapConfig().broadcastRelaySet ?? {});
    const routeTiles = _getBroadcastRelayRouteTiles(layout);

    for (const point of routeTiles) {
      expect(
        point.x >= layout.breakAccess.bounds.x &&
          point.x < layout.breakAccess.bounds.x + layout.breakAccess.bounds.width &&
          point.y >= layout.breakAccess.bounds.y &&
          point.y < layout.breakAccess.bounds.y + layout.breakAccess.bounds.height,
      ).toBe(false);
    }

    const finalApproachX = layout.broadcastRelay.bounds.x - 1;
    const halfRouteWidth = Math.floor(layout.routes[0]!.widthTiles / 2);
    const relayApproachCut = new Set<number>();
    for (
      let y = layout.broadcastRelay.target.y - halfRouteWidth;
      y <= layout.broadcastRelay.target.y + halfRouteWidth;
      y += 1
    ) {
      relayApproachCut.add(tileKey(map, finalApproachX, y));
    }
    const convergence = { x: 48, y: layout.broadcastRelay.target.y };

    for (const route of layout.routes) {
      const entrance = layout.entrances.find((candidate) => candidate.id === route.entranceId)!;
      for (const footprint of layout.supportedFootprints) {
        expect(
          canReach(map, entrance.spawn, convergence, footprint, relayApproachCut),
          `${route.id} must still enter the wider map for ${footprint.id}`,
        ).toBe(true);
        expect(
          canReach(map, entrance.spawn, layout.broadcastRelay.target, footprint, relayApproachCut),
          `${route.id} must not gain an off-lane path for ${footprint.id}`,
        ).toBe(false);
      }
    }
  });
});

describe('Floor 6 plumbing', () => {
  it('is registered and playable but remains unreleased and non-MVP', () => {
    const manifest = getFloorManifest('floor6');
    expect(manifest).toBe(floor6Manifest);
    expect(manifest?.map.biome).toBe(BiomeType.BROADCAST_RELAY_SET);
    expect(manifest?.implemented).toEqual({ mvp: false, released: false });
    expect(getAvailableFloorIds()).toContain('floor6');
    expect(getImplementedFloorIds()).not.toContain('floor6');
    expect(isFloorPlayable('floor6')).toBe(true);

    const scenario = getScenarioDefinition('floor6');
    expect(scenario.floorId).toBe('floor6');
    expect(scenario.onStairDescend?.({} as never, 0)).toBe(false);
    expect(scenario.nextFloorId).toBeUndefined();
  });
});
