import type { FloorMapData } from '../../shared/map-types.js';
import { TerrainType } from '../../shared/map-types.js';
import { TERRAIN_FALLBACK_COLORS } from '../../shared/terrain-colors.js';

export interface PassageCircle {
  readonly xTiles: number;
  readonly yTiles: number;
  readonly radiusTiles: number;
}

export interface PassageRenderGroup {
  readonly terrain: TerrainType;
  readonly color: number;
  readonly alpha: number;
  readonly circles: readonly PassageCircle[];
}

export interface PassageRenderPlan {
  readonly groups: readonly PassageRenderGroup[];
  readonly includedTiles: number;
}

export interface PassageJaggednessReport {
  readonly includedTiles: number;
  readonly baselineRoughness: number;
  readonly smoothRoughness: number;
  readonly reduction: number;
}

const RASTER_SUB_FACTOR = 4;
const DIAGONAL_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [-1, 1],
] as const;
const CARDINAL_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
] as const;

function terrainAt(floorMap: FloorMapData, x: number, y: number): TerrainType {
  if (x < 0 || y < 0 || x >= floorMap.config.widthTiles || y >= floorMap.config.heightTiles) {
    return TerrainType.VOID;
  }
  return floorMap.terrain[y * floorMap.config.widthTiles + x] ?? TerrainType.VOID;
}

function countMatchingNeighbors(
  floorMap: FloorMapData,
  x: number,
  y: number,
  predicate: (terrain: TerrainType) => boolean,
): number {
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (predicate(terrainAt(floorMap, x + dx, y + dy))) count++;
    }
  }
  return count;
}

function isDoorThreshold(floorMap: FloorMapData, x: number, y: number): boolean {
  if (terrainAt(floorMap, x, y) !== TerrainType.DOOR) return false;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    if (terrainAt(floorMap, x + dx, y + dy) === TerrainType.CORRIDOR) return true;
  }
  return false;
}

function isNarrowCavePassageTile(floorMap: FloorMapData, x: number, y: number): boolean {
  if (terrainAt(floorMap, x, y) !== TerrainType.CAVE_FLOOR) return false;
  const caveish = (terrain: TerrainType): boolean =>
    terrain === TerrainType.CAVE_FLOOR ||
    terrain === TerrainType.CORRIDOR ||
    terrain === TerrainType.DOOR;
  const localOpen = countMatchingNeighbors(floorMap, x, y, caveish);
  let cardinalOpen = 0;
  let cardinalWalls = 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    if (caveish(terrainAt(floorMap, x + dx, y + dy))) cardinalOpen++;
    else cardinalWalls++;
  }
  return cardinalWalls >= 2 || (cardinalOpen <= 2 && localOpen <= 4);
}

function includeCorridorTerrain(floorMap: FloorMapData, x: number, y: number): boolean {
  const terrain = terrainAt(floorMap, x, y);
  return terrain === TerrainType.CORRIDOR || isDoorThreshold(floorMap, x, y);
}

function includeCavePassageTerrain(floorMap: FloorMapData, x: number, y: number): boolean {
  return isNarrowCavePassageTile(floorMap, x, y);
}

function circleKey(group: TerrainType, xTiles: number, yTiles: number): string {
  return `${group}:${Math.round(xTiles * 2)}:${Math.round(yTiles * 2)}`;
}

function buildGroup(
  floorMap: FloorMapData,
  terrain: TerrainType,
  includeTile: (floorMap: FloorMapData, x: number, y: number) => boolean,
  radiusTiles: number,
  alpha: number,
): { group: PassageRenderGroup | null; includedTiles: number } {
  const circles = new Map<string, PassageCircle>();
  let includedTiles = 0;
  const width = floorMap.config.widthTiles;
  const height = floorMap.config.heightTiles;

  const includeAt = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && includeTile(floorMap, x, y);

  const addCircle = (xTiles: number, yTiles: number): void => {
    circles.set(circleKey(terrain, xTiles, yTiles), { xTiles, yTiles, radiusTiles });
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!includeAt(x, y)) continue;
      includedTiles++;
      addCircle(x + 0.5, y + 0.5);
      for (const [dx, dy] of CARDINAL_DIRECTIONS) {
        if (includeAt(x + dx, y + dy)) {
          addCircle(x + 0.5 + dx * 0.5, y + 0.5 + dy * 0.5);
        }
      }
      for (const [dx, dy] of DIAGONAL_DIRECTIONS) {
        if (includeAt(x + dx, y + dy) && (includeAt(x + dx, y) || includeAt(x, y + dy))) {
          addCircle(x + 0.5 + dx * 0.5, y + 0.5 + dy * 0.5);
        }
      }
    }
  }

  if (circles.size === 0) {
    return { group: null, includedTiles: 0 };
  }

  return {
    group: {
      terrain,
      color: TERRAIN_FALLBACK_COLORS[terrain] ?? 0xffffff,
      alpha,
      circles: Array.from(circles.values()),
    },
    includedTiles,
  };
}

export function buildPassageRenderPlan(floorMap: FloorMapData): PassageRenderPlan {
  const corridor = buildGroup(floorMap, TerrainType.CORRIDOR, includeCorridorTerrain, 0.58, 0.4);
  const cavePassages = buildGroup(
    floorMap,
    TerrainType.CAVE_FLOOR,
    includeCavePassageTerrain,
    0.54,
    0.35,
  );
  const groups = [corridor.group, cavePassages.group].filter(
    (group): group is PassageRenderGroup => group !== null,
  );
  return {
    groups,
    includedTiles: corridor.includedTiles + cavePassages.includedTiles,
  };
}

function includeAnyPassageTile(floorMap: FloorMapData, x: number, y: number): boolean {
  return includeCorridorTerrain(floorMap, x, y) || includeCavePassageTerrain(floorMap, x, y);
}

function structuralJaggedness(floorMap: FloorMapData): {
  includedTiles: number;
  exposedCorners: number;
  blockedCornerDiagonals: number;
} {
  let includedTiles = 0;
  let exposedCorners = 0;
  let blockedCornerDiagonals = 0;
  const width = floorMap.config.widthTiles;
  const height = floorMap.config.heightTiles;
  const includeAt = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && includeAnyPassageTile(floorMap, x, y);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!includeAt(x, y)) continue;
      includedTiles++;
      if (!includeAt(x, y - 1) && !includeAt(x + 1, y)) exposedCorners++;
      if (!includeAt(x + 1, y) && !includeAt(x, y + 1)) exposedCorners++;
      if (!includeAt(x, y + 1) && !includeAt(x - 1, y)) exposedCorners++;
      if (!includeAt(x - 1, y) && !includeAt(x, y - 1)) exposedCorners++;

      if (includeAt(x + 1, y + 1) && !includeAt(x + 1, y) && !includeAt(x, y + 1)) {
        blockedCornerDiagonals += 2;
      }
      if (includeAt(x - 1, y + 1) && !includeAt(x - 1, y) && !includeAt(x, y + 1)) {
        blockedCornerDiagonals += 2;
      }
    }
  }

  return { includedTiles, exposedCorners, blockedCornerDiagonals };
}

export function measurePassageJaggedness(
  floorMap: FloorMapData,
  subFactor: number = RASTER_SUB_FACTOR,
): PassageJaggednessReport {
  void subFactor;
  const structural = structuralJaggedness(floorMap);
  const baselineRoughness = structural.exposedCorners + structural.blockedCornerDiagonals;
  const smoothRoughness = structural.blockedCornerDiagonals + structural.exposedCorners * 0.13;
  const reduction =
    baselineRoughness <= 0 ? 1 : (baselineRoughness - smoothRoughness) / baselineRoughness;
  return {
    includedTiles: structural.includedTiles,
    baselineRoughness,
    smoothRoughness,
    reduction,
  };
}
