export interface CollisionPair {
  a: number;
  b: number;
}

export interface SpatialHashGrid {
  clear(): void;
  insert(eid: number, x: number, y: number, halfWidth: number, halfHeight: number): void;
  queryPairs(): CollisionPair[];
  queryRadius(x: number, y: number, radius: number): number[];
}

const DEFAULT_CELL_SIZE = 64;
const MAX_TRACKED_ENTITIES = 10_000;
const PAIR_KEY_STRIDE = 131_072;

function toUnsignedCoordinate(value: number): number {
  return value >= 0 ? value * 2 : (-value * 2) - 1;
}

function hashCell(cellX: number, cellY: number): number {
  const x = toUnsignedCoordinate(cellX);
  const y = toUnsignedCoordinate(cellY);
  return x >= y ? (x * x) + x + y : (y * y) + x;
}

function circleIntersectsAabb(
  pointX: number,
  pointY: number,
  radius: number,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): boolean {
  const dx = Math.abs(pointX - centerX);
  const dy = Math.abs(pointY - centerY);

  if (dx > halfWidth + radius || dy > halfHeight + radius) {
    return false;
  }

  if (dx <= halfWidth || dy <= halfHeight) {
    return true;
  }

  const cornerDx = dx - halfWidth;
  const cornerDy = dy - halfHeight;
  return (cornerDx * cornerDx) + (cornerDy * cornerDy) <= radius * radius;
}

class SpatialHashGridImpl implements SpatialHashGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly cellPool: number[][] = [];
  private readonly centersX = new Float32Array(MAX_TRACKED_ENTITIES);
  private readonly centersY = new Float32Array(MAX_TRACKED_ENTITIES);
  private readonly halfWidths = new Float32Array(MAX_TRACKED_ENTITIES);
  private readonly halfHeights = new Float32Array(MAX_TRACKED_ENTITIES);
  private readonly pairKeys = new Set<number>();
  private readonly pairs: CollisionPair[] = [];
  private readonly radiusResults: number[] = [];
  private readonly radiusMarks = new Uint32Array(MAX_TRACKED_ENTITIES);
  private radiusStamp = 0;

  constructor(private readonly cellSize: number) {}

  clear(): void {
    for (const bucket of this.cells.values()) {
      bucket.length = 0;
      this.cellPool.push(bucket);
    }

    this.cells.clear();
    this.pairs.length = 0;
    this.radiusResults.length = 0;
    this.pairKeys.clear();
  }

  insert(eid: number, x: number, y: number, halfWidth: number, halfHeight: number): void {
    const clampedHalfWidth = Math.abs(halfWidth);
    const clampedHalfHeight = Math.abs(halfHeight);
    this.centersX[eid] = x;
    this.centersY[eid] = y;
    this.halfWidths[eid] = clampedHalfWidth;
    this.halfHeights[eid] = clampedHalfHeight;

    const minCellX = Math.floor((x - clampedHalfWidth) / this.cellSize);
    const maxCellX = Math.floor((x + clampedHalfWidth) / this.cellSize);
    const minCellY = Math.floor((y - clampedHalfHeight) / this.cellSize);
    const maxCellY = Math.floor((y + clampedHalfHeight) / this.cellSize);

    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const key = hashCell(cellX, cellY);
        let bucket = this.cells.get(key);

        if (bucket === undefined) {
          bucket = this.cellPool.pop() ?? [];
          this.cells.set(key, bucket);
        }

        bucket.push(eid);
      }
    }
  }

  queryPairs(): CollisionPair[] {
    this.pairs.length = 0;
    this.pairKeys.clear();

    let pairCount = 0;

    for (const bucket of this.cells.values()) {
      const bucketLength = bucket.length;

      if (bucketLength < 2) {
        continue;
      }

      for (let indexA = 0; indexA < bucketLength - 1; indexA += 1) {
        const first = bucket[indexA];

        if (first === undefined) {
          continue;
        }

        for (let indexB = indexA + 1; indexB < bucketLength; indexB += 1) {
          const second = bucket[indexB];

          if (second === undefined || first === second) {
            continue;
          }

          const a = first < second ? first : second;
          const b = first < second ? second : first;
          const pairKey = (a * PAIR_KEY_STRIDE) + b;

          if (this.pairKeys.has(pairKey)) {
            continue;
          }

          this.pairKeys.add(pairKey);

          const centerAX = this.centersX[a] ?? 0;
          const centerBX = this.centersX[b] ?? 0;
          const centerAY = this.centersY[a] ?? 0;
          const centerBY = this.centersY[b] ?? 0;
          const halfWidthA = this.halfWidths[a] ?? 0;
          const halfWidthB = this.halfWidths[b] ?? 0;
          const halfHeightA = this.halfHeights[a] ?? 0;
          const halfHeightB = this.halfHeights[b] ?? 0;
          const overlapsX = Math.abs(centerAX - centerBX) <= halfWidthA + halfWidthB;
          const overlapsY = Math.abs(centerAY - centerBY) <= halfHeightA + halfHeightB;

          if (!overlapsX || !overlapsY) {
            continue;
          }

          const pair = this.pairs[pairCount];
          if (pair === undefined) {
            this.pairs.push({ a, b });
          } else {
            pair.a = a;
            pair.b = b;
          }

          pairCount += 1;
        }
      }
    }

    this.pairs.length = pairCount;
    return this.pairs;
  }

  queryRadius(x: number, y: number, radius: number): number[] {
    this.radiusResults.length = 0;
    const queryRadius = Math.abs(radius);
    const minCellX = Math.floor((x - queryRadius) / this.cellSize);
    const maxCellX = Math.floor((x + queryRadius) / this.cellSize);
    const minCellY = Math.floor((y - queryRadius) / this.cellSize);
    const maxCellY = Math.floor((y + queryRadius) / this.cellSize);
    const stamp = this.nextRadiusStamp();
    let resultCount = 0;

    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const bucket = this.cells.get(hashCell(cellX, cellY));

        if (bucket === undefined) {
          continue;
        }

        for (let index = 0; index < bucket.length; index += 1) {
          const eid = bucket[index];

          if (eid === undefined || this.radiusMarks[eid] === stamp) {
            continue;
          }

          this.radiusMarks[eid] = stamp;

          const centerX = this.centersX[eid] ?? 0;
          const centerY = this.centersY[eid] ?? 0;
          const halfWidth = this.halfWidths[eid] ?? 0;
          const halfHeight = this.halfHeights[eid] ?? 0;

          if (!circleIntersectsAabb(
            x,
            y,
            queryRadius,
            centerX,
            centerY,
            halfWidth,
            halfHeight,
          )) {
            continue;
          }

          this.radiusResults[resultCount] = eid;
          resultCount += 1;
        }
      }
    }

    this.radiusResults.length = resultCount;
    return this.radiusResults;
  }

  private nextRadiusStamp(): number {
    this.radiusStamp = (this.radiusStamp + 1) >>> 0;

    if (this.radiusStamp === 0) {
      this.radiusMarks.fill(0);
      this.radiusStamp = 1;
    }

    return this.radiusStamp;
  }
}

export function createSpatialHashGrid(cellSize = DEFAULT_CELL_SIZE): SpatialHashGrid {
  return new SpatialHashGridImpl(cellSize);
}
