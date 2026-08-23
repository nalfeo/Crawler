/**
 * ShowcaseArenaGenerator — Floor 4's authored broadcast venue.
 *
 * Unlike every other generator in this folder, this one **generates nothing**:
 * the venue is authored, so the layout is a pure function of the geometry
 * numbers in {@link MapConfig.showcaseArena} and the RNG is never touched
 * (ADR 0090 D6 / spec FR7 — Floor 4's variety comes from its seeded Headliner
 * card and rotating shops, not from its floorplan). Two runs of two different
 * seeds produce byte-identical geometry, which is what lets wave manifests name
 * a fixed gate index.
 *
 * Produces, west → east:
 *
 * ```
 *   ┌──────────────── arena ────────────────┐        ┌── green room ──┐
 *   │  N gate                               │ tunnel │                │
 *   │  W gate      ▪ pillars ▪      E gate  ├────────┤   (SAFE)       │
 *   │  S gate                               │        │                │
 *   └───────────────────────────────────────┘        └────────────────┘
 * ```
 *
 * Slice-1 scope (see `.specify/specs/floor4-arena.md` §Epic decomposition): the
 * curtain tunnel ships **open** so the player can walk into the Green Room,
 * which is exactly slice 1's acceptance criterion. FR9.4 (arena and Green Room
 * never simultaneously reachable) is satisfied by the slice-5 intermission
 * transaction, which seals the tunnel; it is deliberately NOT claimed here.
 */

import type { ArenaFeedGate, MapConfig, RoomBounds } from '../../../shared/map-types';
import { TilePresets, TerrainType, RoomRole } from '../../../shared/map-types';
import type { SeededRandom } from '../../../shared/random';
import { TileMap } from '../TileMap';
import { RoomGraph } from '../RoomGraph';
import { FloorMap } from '../FloorMap';
import type { MapGenerator } from './types';

/** Authored venue geometry, in tiles. Every field is a tile count. */
export interface ShowcaseArenaOptions {
  arenaWidthTiles: number;
  arenaHeightTiles: number;
  greenRoomWidthTiles: number;
  greenRoomHeightTiles: number;
  tunnelLengthTiles: number;
  tunnelWidthTiles: number;
  pillarSizeTiles: number;
  pillarInsetTiles: number;
  borderThicknessTiles: number;
}

/**
 * The authored Floor 4 venue. Changing these numbers changes where every gate
 * sits, so they live in one place and the floor manifest overrides them
 * explicitly rather than each caller inventing its own.
 */
export const DEFAULT_SHOWCASE_ARENA_OPTIONS: ShowcaseArenaOptions = {
  arenaWidthTiles: 48,
  arenaHeightTiles: 40,
  greenRoomWidthTiles: 20,
  greenRoomHeightTiles: 14,
  tunnelLengthTiles: 8,
  tunnelWidthTiles: 4,
  pillarSizeTiles: 3,
  pillarInsetTiles: 10,
  borderThicknessTiles: 2,
};

/** Fully resolved venue layout in tile coordinates. */
export interface ShowcaseArenaLayout {
  /** Total map size the layout needs. */
  readonly widthTiles: number;
  readonly heightTiles: number;
  /** Arena playfield (passable interior). */
  readonly arena: RoomBounds;
  /** Curtain tunnel connecting arena → Green Room (passable interior). */
  readonly tunnel: RoomBounds;
  /** Green Room lounge (passable interior). */
  readonly greenRoom: RoomBounds;
  /** Solid pit-fixture pillars inside the arena. */
  readonly pillars: readonly RoomBounds[];
  /** Feed gates in fixed index order: 0 = north, 1 = east, 2 = south, 3 = west. */
  readonly feedGates: readonly ArenaFeedGate[];
  /** Player spawn tile (arena centre). */
  readonly playerSpawn: { readonly x: number; readonly y: number };
}

function requirePositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ShowcaseArenaGenerator: ${name} must be a positive integer, got ${value}`);
  }
}

function rectsOverlap(a: RoomBounds, b: RoomBounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Resolve the authored layout. Pure: no RNG, no map allocation — so callers
 * (tests, and later slices that need gate positions before generation) can ask
 * for the geometry without building a whole floor.
 *
 * Throws on any geometry that cannot be built correctly rather than silently
 * clamping, because a clamped venue would move gate tiles and silently
 * invalidate every seeded wave manifest.
 */
export function computeShowcaseArenaLayout(
  options: Partial<ShowcaseArenaOptions> = {},
): ShowcaseArenaLayout {
  const opts: ShowcaseArenaOptions = { ...DEFAULT_SHOWCASE_ARENA_OPTIONS, ...options };
  for (const [name, value] of Object.entries(opts)) {
    requirePositiveInt(name, value);
  }

  const border = opts.borderThicknessTiles;
  const arena: RoomBounds = {
    x: border,
    y: border,
    width: opts.arenaWidthTiles,
    height: opts.arenaHeightTiles,
  };

  // The tunnel leaves the arena's east wall low enough that its mouth can never
  // collide with the east feed gate (asserted below).
  const tunnelY =
    arena.y + Math.floor((arena.height * 3) / 4) - Math.floor(opts.tunnelWidthTiles / 2);
  const tunnel: RoomBounds = {
    x: arena.x + arena.width,
    y: tunnelY,
    width: opts.tunnelLengthTiles,
    height: opts.tunnelWidthTiles,
  };

  const greenRoom: RoomBounds = {
    x: tunnel.x + tunnel.width,
    y: tunnel.y + Math.floor(tunnel.height / 2) - Math.floor(opts.greenRoomHeightTiles / 2),
    width: opts.greenRoomWidthTiles,
    height: opts.greenRoomHeightTiles,
  };

  if (greenRoom.y < border) {
    throw new Error(
      'ShowcaseArenaGenerator: green room does not fit above the venue border; increase arenaHeightTiles or shrink greenRoomHeightTiles',
    );
  }

  const inset = opts.pillarInsetTiles;
  const size = opts.pillarSizeTiles;
  if (inset + size >= Math.min(arena.width, arena.height) / 2) {
    throw new Error(
      'ShowcaseArenaGenerator: pit-fixture pillars would meet in the middle of the arena; reduce pillarInsetTiles/pillarSizeTiles',
    );
  }
  const pillars: RoomBounds[] = [
    { x: arena.x + inset, y: arena.y + inset, width: size, height: size },
    { x: arena.x + arena.width - inset - size, y: arena.y + inset, width: size, height: size },
    { x: arena.x + inset, y: arena.y + arena.height - inset - size, width: size, height: size },
    {
      x: arena.x + arena.width - inset - size,
      y: arena.y + arena.height - inset - size,
      width: size,
      height: size,
    },
  ];

  const midX = arena.x + Math.floor(arena.width / 2);
  const midY = arena.y + Math.floor(arena.height / 2);
  // ORDER IS A DATA CONTRACT — wave manifests name gates by index (FR3.4).
  const feedGates: ArenaFeedGate[] = [
    { index: 0, direction: 'north', x: midX, y: arena.y },
    { index: 1, direction: 'east', x: arena.x + arena.width - 1, y: midY },
    { index: 2, direction: 'south', x: midX, y: arena.y + arena.height - 1 },
    { index: 3, direction: 'west', x: arena.x, y: midY },
  ];

  const tunnelMouth: RoomBounds = { x: tunnel.x - 1, y: tunnel.y, width: 1, height: tunnel.height };
  for (const gate of feedGates) {
    const gateTile: RoomBounds = { x: gate.x, y: gate.y, width: 1, height: 1 };
    if (rectsOverlap(gateTile, tunnelMouth)) {
      throw new Error(
        `ShowcaseArenaGenerator: feed gate ${gate.index} (${gate.direction}) collides with the curtain-tunnel mouth`,
      );
    }
    for (const pillar of pillars) {
      if (rectsOverlap(gateTile, pillar)) {
        throw new Error(
          `ShowcaseArenaGenerator: feed gate ${gate.index} (${gate.direction}) is blocked by a pit fixture`,
        );
      }
    }
  }

  return {
    widthTiles: greenRoom.x + greenRoom.width + border,
    heightTiles: Math.max(arena.y + arena.height, greenRoom.y + greenRoom.height) + border,
    arena,
    tunnel,
    greenRoom,
    pillars,
    feedGates,
    playerSpawn: { x: midX, y: midY },
  };
}

/** Read the authored-venue overrides a floor manifest passed through `MapConfig`. */
export function showcaseArenaOptionsFromConfig(config: MapConfig): Partial<ShowcaseArenaOptions> {
  const raw = config.showcaseArena;
  if (!raw) return {};
  const entries = Object.entries(raw).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<ShowcaseArenaOptions>;
}

export class ShowcaseArenaGenerator implements MapGenerator {
  readonly name = 'ShowcaseArenaGenerator';

  /**
   * @param _rng deliberately unused — the venue is authored (see module docs).
   */
  generate(config: MapConfig, _rng: SeededRandom): FloorMap {
    const layout = computeShowcaseArenaLayout(showcaseArenaOptionsFromConfig(config));
    const w = config.widthTiles;
    const h = config.heightTiles;
    if (w < layout.widthTiles || h < layout.heightTiles) {
      throw new Error(
        `ShowcaseArenaGenerator: map is ${w}x${h} tiles but the authored venue needs at least ${layout.widthTiles}x${layout.heightTiles}`,
      );
    }

    const tileMap = new TileMap(w, h);
    const terrain = new Uint8Array(w * h);
    tileMap.fill(TilePresets.WALL);
    terrain.fill(TerrainType.STONE_WALL);

    const carve = (rect: RoomBounds, terrainType: TerrainType): void => {
      tileMap.fillRect(rect.x, rect.y, rect.width, rect.height, TilePresets.FLOOR);
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        for (let x = rect.x; x < rect.x + rect.width; x += 1) {
          terrain[y * w + x] = terrainType;
        }
      }
    };

    carve(layout.arena, TerrainType.STONE_FLOOR);
    carve(layout.tunnel, TerrainType.CORRIDOR);
    carve(layout.greenRoom, TerrainType.SAFE_ROOM_FLOOR);

    for (const pillar of layout.pillars) {
      tileMap.fillRect(pillar.x, pillar.y, pillar.width, pillar.height, TilePresets.WALL);
      for (let y = pillar.y; y < pillar.y + pillar.height; y += 1) {
        for (let x = pillar.x; x < pillar.x + pillar.width; x += 1) {
          terrain[y * w + x] = TerrainType.STONE_WALL;
        }
      }
    }

    const roomGraph = new RoomGraph();
    // Ids are assigned in insertion order, so the neighbour links can be
    // authored up front. Asserted rather than assumed.
    const ARENA_ID = 0;
    const GREEN_ROOM_ID = 1;
    const arenaId = roomGraph.add(layout.arena, [], [GREEN_ROOM_ID], RoomRole.SPAWN, 'the-pit');
    // Rooms are linked by the open curtain tunnel. No door entities in slice 1
    // — the seal is the slice-5 intermission transaction, not a door.
    const greenRoomId = roomGraph.add(
      layout.greenRoom,
      [],
      [ARENA_ID],
      RoomRole.SAFE,
      'green-room',
    );
    if (arenaId !== ARENA_ID || greenRoomId !== GREEN_ROOM_ID) {
      throw new Error(
        'ShowcaseArenaGenerator: unexpected room ids; neighbour links would be wrong',
      );
    }

    return new FloorMap(
      config,
      tileMap,
      roomGraph,
      terrain,
      { x: layout.playerSpawn.x, y: layout.playerSpawn.y },
      undefined,
      [],
      layout.feedGates,
    );
  }
}
