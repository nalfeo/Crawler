/**
 * SiegeCastleGenerator — Floor 5's authored Command Post-to-throne battlefield.
 *
 * Slice 1 authors structure only: a reachable Command Post, primary lane, flank
 * task pockets, pre-open breach seam, courtyard, throne room, and Winner's
 * Balcony. Later slices add live structures, waves, Heroes, ram collision
 * changes, and dressing; this generator consumes no RNG so those future
 * manifests can name stable locations.
 */

import type { MapConfig, RoomBounds } from '../../../shared/map-types';
import { RoomRole, TerrainType, TilePresets } from '../../../shared/map-types';
import type { SeededRandom } from '../../../shared/random';
import { FloorMap } from '../FloorMap';
import { RoomGraph } from '../RoomGraph';
import { TileMap } from '../TileMap';
import type { MapGenerator } from './types';

export interface SiegeCastleOptions {
  commandPostWidthTiles: number;
  commandPostHeightTiles: number;
  siegeYardWidthTiles: number;
  siegeYardHeightTiles: number;
  pocketWidthTiles: number;
  pocketHeightTiles: number;
  laneLengthTiles: number;
  laneWidthTiles: number;
  checkpointCount: number;
  outerWallThicknessTiles: number;
  breachWidthTiles: number;
  courtyardWidthTiles: number;
  courtyardHeightTiles: number;
  throneRoomWidthTiles: number;
  throneRoomHeightTiles: number;
  balconyWidthTiles: number;
  balconyHeightTiles: number;
  borderThicknessTiles: number;
}

const DEFAULT_SIEGE_CASTLE_OPTIONS: SiegeCastleOptions = {
  commandPostWidthTiles: 14,
  commandPostHeightTiles: 12,
  siegeYardWidthTiles: 16,
  siegeYardHeightTiles: 10,
  pocketWidthTiles: 14,
  pocketHeightTiles: 10,
  laneLengthTiles: 46,
  laneWidthTiles: 8,
  checkpointCount: 2,
  outerWallThicknessTiles: 3,
  breachWidthTiles: 6,
  courtyardWidthTiles: 20,
  courtyardHeightTiles: 18,
  throneRoomWidthTiles: 18,
  throneRoomHeightTiles: 14,
  balconyWidthTiles: 14,
  balconyHeightTiles: 8,
  borderThicknessTiles: 2,
};

export interface SiegeCastleSetPiece {
  readonly id: string;
  readonly bounds: RoomBounds;
}

export interface SiegeCastleLayout {
  readonly widthTiles: number;
  readonly heightTiles: number;
  readonly commandPost: RoomBounds;
  readonly siegeYard: RoomBounds;
  readonly componentPocket: RoomBounds;
  readonly checkpointPocket: RoomBounds;
  readonly primaryLane: RoomBounds;
  readonly outerWall: RoomBounds;
  readonly breachSite: RoomBounds;
  readonly courtyard: RoomBounds;
  readonly throneRoom: RoomBounds;
  readonly winnersBalcony: RoomBounds;
  readonly playerSpawn: { readonly x: number; readonly y: number };
  readonly setPieces: readonly SiegeCastleSetPiece[];
}

function requirePositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`SiegeCastleGenerator: ${name} must be a positive integer, got ${value}`);
  }
}

function centerY(rect: RoomBounds): number {
  return rect.y + Math.floor(rect.height / 2);
}

function centerX(rect: RoomBounds): number {
  return rect.x + Math.floor(rect.width / 2);
}

export function computeSiegeCastleLayout(
  options: Partial<SiegeCastleOptions> = {},
): SiegeCastleLayout {
  const opts: SiegeCastleOptions = { ...DEFAULT_SIEGE_CASTLE_OPTIONS, ...options };
  for (const [name, value] of Object.entries(opts)) {
    requirePositiveInt(name, value);
  }
  if (opts.breachWidthTiles > opts.laneWidthTiles) {
    throw new Error('SiegeCastleGenerator: breach width cannot exceed primary lane width');
  }

  const border = opts.borderThicknessTiles;
  const verticalGap = 4;
  const laneY = border + opts.pocketHeightTiles + verticalGap;
  const laneCenterY = laneY + Math.floor(opts.laneWidthTiles / 2);

  const commandPost: RoomBounds = {
    x: border,
    y: laneCenterY - Math.floor(opts.commandPostHeightTiles / 2),
    width: opts.commandPostWidthTiles,
    height: opts.commandPostHeightTiles,
  };
  const primaryLane: RoomBounds = {
    x: commandPost.x + commandPost.width,
    y: laneY,
    width: opts.laneLengthTiles,
    height: opts.laneWidthTiles,
  };
  const outerWall: RoomBounds = {
    x: primaryLane.x + primaryLane.width,
    y: border,
    width: opts.outerWallThicknessTiles,
    height: opts.pocketHeightTiles + opts.laneWidthTiles + opts.pocketHeightTiles + verticalGap * 2,
  };
  const breachSite: RoomBounds = {
    x: outerWall.x,
    y: laneCenterY - Math.floor(opts.breachWidthTiles / 2),
    width: opts.outerWallThicknessTiles,
    height: opts.breachWidthTiles,
  };
  const courtyard: RoomBounds = {
    x: outerWall.x + outerWall.width,
    y: laneCenterY - Math.floor(opts.courtyardHeightTiles / 2),
    width: opts.courtyardWidthTiles,
    height: opts.courtyardHeightTiles,
  };
  const throneRoom: RoomBounds = {
    x: courtyard.x + courtyard.width,
    y: laneCenterY - Math.floor(opts.throneRoomHeightTiles / 2),
    width: opts.throneRoomWidthTiles,
    height: opts.throneRoomHeightTiles,
  };
  const winnersBalcony: RoomBounds = {
    x: throneRoom.x + throneRoom.width,
    y: laneCenterY - Math.floor(opts.balconyHeightTiles / 2),
    width: opts.balconyWidthTiles,
    height: opts.balconyHeightTiles,
  };
  const siegeYard: RoomBounds = {
    x: primaryLane.x + 4,
    y: border,
    width: opts.siegeYardWidthTiles,
    height: opts.siegeYardHeightTiles,
  };
  const componentPocket: RoomBounds = {
    x: primaryLane.x + 24,
    y: border,
    width: opts.pocketWidthTiles,
    height: opts.pocketHeightTiles,
  };
  const checkpointPocket: RoomBounds = {
    x: primaryLane.x + 24,
    y: primaryLane.y + primaryLane.height + verticalGap,
    width: opts.pocketWidthTiles,
    height: opts.pocketHeightTiles,
  };

  const setPieces: SiegeCastleSetPiece[] = [
    { id: 'command-post', bounds: commandPost },
    { id: 'siege-yard', bounds: siegeYard },
    { id: 'component-pocket', bounds: componentPocket },
    { id: 'checkpoint-pocket', bounds: checkpointPocket },
    { id: 'primary-lane', bounds: primaryLane },
    { id: 'outer-wall', bounds: outerWall },
    { id: 'breach-site', bounds: breachSite },
    { id: 'courtyard', bounds: courtyard },
    { id: 'throne-room', bounds: throneRoom },
    { id: 'winners-balcony', bounds: winnersBalcony },
  ];

  const widthTiles = winnersBalcony.x + winnersBalcony.width + border;
  const heightTiles =
    Math.max(...setPieces.map((piece) => piece.bounds.y + piece.bounds.height)) + border;

  return {
    widthTiles,
    heightTiles,
    commandPost,
    siegeYard,
    componentPocket,
    checkpointPocket,
    primaryLane,
    outerWall,
    breachSite,
    courtyard,
    throneRoom,
    winnersBalcony,
    playerSpawn: { x: centerX(commandPost), y: centerY(commandPost) },
    setPieces,
  };
}

export function siegeCastleOptionsFromConfig(config: MapConfig): Partial<SiegeCastleOptions> {
  const raw = config.siegeCastle;
  if (!raw) return {};
  const entries = Object.entries(raw).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<SiegeCastleOptions>;
}

export class SiegeCastleGenerator implements MapGenerator {
  readonly name = 'SiegeCastleGenerator';

  generate(config: MapConfig, _rng: SeededRandom): FloorMap {
    const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(config));
    const w = config.widthTiles;
    const h = config.heightTiles;
    if (w < layout.widthTiles || h < layout.heightTiles) {
      throw new Error(
        `SiegeCastleGenerator: map is ${w}x${h} tiles but the authored battlefield needs at least ${layout.widthTiles}x${layout.heightTiles}`,
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
    const carveVerticalConnector = (room: RoomBounds): void => {
      const x = centerX(room);
      const y1 = Math.min(centerY(room), centerY(layout.primaryLane));
      const y2 = Math.max(centerY(room), centerY(layout.primaryLane));
      carve({ x, y: y1, width: 1, height: y2 - y1 + 1 }, TerrainType.CORRIDOR);
    };

    carve(layout.commandPost, TerrainType.WOOD_FLOOR);
    carve(layout.primaryLane, TerrainType.CORRIDOR);
    carve(layout.siegeYard, TerrainType.DIRT);
    carve(layout.componentPocket, TerrainType.DIRT);
    carve(layout.checkpointPocket, TerrainType.DIRT);
    carve(layout.breachSite, TerrainType.RUBBLE);
    carve(layout.courtyard, TerrainType.STONE_FLOOR);
    carve(layout.throneRoom, TerrainType.BOSS_STAIR_FLOOR);
    carve(layout.winnersBalcony, TerrainType.WOOD_FLOOR);
    carveVerticalConnector(layout.siegeYard);
    carveVerticalConnector(layout.componentPocket);
    carveVerticalConnector(layout.checkpointPocket);

    const roomGraph = new RoomGraph();
    const COMMAND_POST = roomGraph.add(layout.commandPost, [], [4], RoomRole.SPAWN, 'command-post');
    const SIEGE_YARD = roomGraph.add(layout.siegeYard, [], [4], RoomRole.NORMAL, 'siege-yard');
    const COMPONENT = roomGraph.add(
      layout.componentPocket,
      [],
      [4],
      RoomRole.NORMAL,
      'component-pocket',
    );
    const CHECKPOINT = roomGraph.add(
      layout.checkpointPocket,
      [],
      [4],
      RoomRole.NORMAL,
      'checkpoint-pocket',
    );
    const LANE = roomGraph.add(
      layout.primaryLane,
      [],
      [0, 1, 2, 3, 5],
      RoomRole.NORMAL,
      'primary-lane',
    );
    const COURTYARD = roomGraph.add(layout.courtyard, [], [4, 6], RoomRole.NORMAL, 'courtyard');
    const THRONE = roomGraph.add(layout.throneRoom, [], [5, 7], RoomRole.BOSS_STAIR, 'throne-room');
    const BALCONY = roomGraph.add(
      layout.winnersBalcony,
      [],
      [6],
      RoomRole.NORMAL,
      'winners-balcony',
    );
    if (
      COMMAND_POST !== 0 ||
      SIEGE_YARD !== 1 ||
      COMPONENT !== 2 ||
      CHECKPOINT !== 3 ||
      LANE !== 4 ||
      COURTYARD !== 5 ||
      THRONE !== 6 ||
      BALCONY !== 7
    ) {
      throw new Error('SiegeCastleGenerator: unexpected room ids; neighbour links would be wrong');
    }

    return new FloorMap(config, tileMap, roomGraph, terrain, layout.playerSpawn);
  }
}
