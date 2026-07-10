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
        if (includeAt(x + dx, y + dy)) {
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

function rasterizeRect(
  mask: Uint8Array,
  maskWidth: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  for (let y = startY; y < endY; y++) {
    const row = y * maskWidth;
    for (let x = startX; x < endX; x++) {
      mask[row + x] = 1;
    }
  }
}

function rasterizeCircle(
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  xTiles: number,
  yTiles: number,
  radiusTiles: number,
  subFactor: number,
): void {
  const cx = xTiles * subFactor;
  const cy = yTiles * subFactor;
  const radius = radiusTiles * subFactor;
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(maskWidth - 1, Math.ceil(cx + radius + 1));
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(maskHeight - 1, Math.ceil(cy + radius + 1));
  const radiusSq = radius * radius;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    const row = y * maskWidth;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= radiusSq) {
        mask[row + x] = 1;
      }
    }
  }
}

function buildBaselineMask(
  floorMap: FloorMapData,
  subFactor: number,
): { mask: Uint8Array; includedTiles: number } {
  const width = floorMap.config.widthTiles * subFactor;
  const height = floorMap.config.heightTiles * subFactor;
  const mask = new Uint8Array(width * height);
  let includedTiles = 0;
  for (let y = 0; y < floorMap.config.heightTiles; y++) {
    for (let x = 0; x < floorMap.config.widthTiles; x++) {
      if (!includeCorridorTerrain(floorMap, x, y) && !includeCavePassageTerrain(floorMap, x, y))
        continue;
      includedTiles++;
      rasterizeRect(
        mask,
        width,
        x * subFactor,
        y * subFactor,
        (x + 1) * subFactor,
        (y + 1) * subFactor,
      );
    }
  }
  return { mask, includedTiles };
}

function buildSmoothMask(
  floorMap: FloorMapData,
  subFactor: number,
): { mask: Uint8Array; includedTiles: number } {
  const width = floorMap.config.widthTiles * subFactor;
  const height = floorMap.config.heightTiles * subFactor;
  const mask = new Uint8Array(width * height);
  const plan = buildPassageRenderPlan(floorMap);
  for (const group of plan.groups) {
    for (const circle of group.circles) {
      rasterizeCircle(
        mask,
        width,
        height,
        circle.xTiles,
        circle.yTiles,
        circle.radiusTiles,
        subFactor,
      );
    }
  }
  return { mask, includedTiles: plan.includedTiles };
}

function roughnessScore(mask: Uint8Array, width: number, height: number): number {
  let roughness = 0;
  for (let y = 0; y < height - 1; y++) {
    const row = y * width;
    const nextRow = (y + 1) * width;
    for (let x = 0; x < width - 1; x++) {
      const a = mask[row + x] ?? 0;
      const b = mask[row + x + 1] ?? 0;
      const c = mask[nextRow + x] ?? 0;
      const d = mask[nextRow + x + 1] ?? 0;
      if (
        (a === 1 && d === 1 && b === 0 && c === 0) ||
        (b === 1 && c === 1 && a === 0 && d === 0)
      ) {
        roughness += 2;
      }
    }
  }
  return roughness;
}

export function measurePassageJaggedness(
  floorMap: FloorMapData,
  subFactor: number = RASTER_SUB_FACTOR,
): PassageJaggednessReport {
  const baseline = buildBaselineMask(floorMap, subFactor);
  const smooth = buildSmoothMask(floorMap, subFactor);
  const width = floorMap.config.widthTiles * subFactor;
  const height = floorMap.config.heightTiles * subFactor;
  const baselineRoughness = roughnessScore(baseline.mask, width, height);
  const smoothRoughness = roughnessScore(smooth.mask, width, height);
  const reduction =
    baselineRoughness <= 0 ? 1 : (baselineRoughness - smoothRoughness) / baselineRoughness;
  return {
    includedTiles: Math.max(baseline.includedTiles, smooth.includedTiles),
    baselineRoughness,
    smoothRoughness,
    reduction,
  };
}
