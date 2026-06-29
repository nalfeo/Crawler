/**
 * Pure grid index/coordinate helpers shared across map generators and
 * pathfinding. A 2D grid is stored row-major: `idx = y * width + x`.
 *
 * Consolidates the ~20 hand-inlined `idx % width` / `(idx - x) / width`
 * conversions and several near-identical flood-fill loops. Pure + deterministic.
 */

/** Column (x) for a row-major index. */
export function indexToX(idx: number, width: number): number {
  return idx % width;
}

/** Row (y) for a row-major index. */
export function indexToY(idx: number, width: number): number {
  return Math.floor(idx / width);
}

/** Decompose a row-major index into `[x, y]`. */
export function indexToCoords(idx: number, width: number): [x: number, y: number] {
  const x = idx % width;
  return [x, (idx - x) / width];
}

/** Compose `[x, y]` into a row-major index. */
export function coordsToIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

/** Orthogonal (4-connected) neighbor offsets: right, left, down, up. */
export const ORTHO_NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * 4-connected flood fill from `start`. Visits every index reachable through
 * `passable` cells using a deterministic stack, invoking `onVisit` once per
 * cell. Returns the visited mask so callers can detect reachability. Pass a
 * shared `visited` buffer to fill across multiple seeds.
 */
export function floodFill(
  start: number,
  width: number,
  height: number,
  passable: (idx: number) => boolean,
  onVisit?: (idx: number) => void,
  visited: Uint8Array = new Uint8Array(width * height),
): Uint8Array {
  if (start < 0 || start >= width * height || !passable(start)) {
    return visited;
  }
  const stack: number[] = [start];
  visited[start] = 1;
  while (stack.length > 0) {
    const idx = stack.pop()!;
    onVisit?.(idx);
    const x = idx % width;
    const y = (idx - x) / width;
    for (const [dx, dy] of ORTHO_NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx] === 1 || !passable(nIdx)) continue;
      visited[nIdx] = 1;
      stack.push(nIdx);
    }
  }
  return visited;
}
