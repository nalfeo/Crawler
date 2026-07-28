/**
 * terrain-linework — deterministic ROUTE planning for industrial linework
 * (mine-cart track and pipe runs) over a floor's walkable topology.
 *
 * Why this exists, and why it is NOT a decal set
 * ---------------------------------------------
 * Ground decals are independent stamps on a jittered lattice: each one knows
 * nothing about its neighbours or about the map. That is exactly right for
 * cracks and exactly wrong for a rail line — a scatter of independent
 * track-segment stamps reads as debris, not as a railway.
 *
 * Linework is instead a PATH-FOLLOWING mechanism. This module picks routes
 * through the actual walkable graph, rasterises them into one shared occupancy
 * grid per layer, and then every occupied tile's art is chosen by its 4-bit
 * edge-Wang mask (see `terrain-pack-mask.ts`) — that is, by which of its
 * neighbours are also on the run. Straight / corner / T / cross / end-cap all
 * fall out of the mask, and junctions between two routes that happen to cross
 * are drawn correctly for free because both routes write the same grid.
 *
 * Layering, not geometry, is what makes runs land where they should: routes are
 * generated as HUB YARDS (short spurs local to a boss den or the resource
 * heart) plus TRUNK LINES connecting hub pairs. Yards are what concentrate
 * density around the interesting rooms; trunks are what make runs long enough
 * to read as infrastructure crossing the whole cavern.
 *
 * Everything here is pure and deterministic: `SeededRandom` seeded only from
 * the floor seed, a tie-broken A*, and no `Date.now()`. Same seed and same map
 * ⇒ byte-identical occupancy.
 *
 * No Phaser, no ECS, no rendering — this is `src/shared/`, importable by the
 * engine, by tests, and by offline tooling alike.
 */
import { hashStringToSeed, SeededRandom } from './random.js';
import { EDGE_WANG_DIRECTIONS, edgeWangMaskFromOccupancy, MASK_BIT } from './terrain-pack-mask.js';

/** Occupancy grid values. */
export const LINEWORK_EMPTY = 0;
/** Tile carries the run on open ground. */
export const LINEWORK_GROUND = 1;
/**
 * Tile carries the run but sits on a WALL tile — a pipe pushed one cell into
 * the rock so it visibly enters/exits the wall face. Stamped after the wall
 * pass so the wall does not overpaint it.
 */
export const LINEWORK_WALL_ENTRY = 2;

/** A tile a route may be attracted to and measured against. */
export interface LineworkHub {
  readonly tx: number;
  readonly ty: number;
}

/** Tunables for one linework layer's route generation. */
export interface LineworkLayerParams {
  /** Short routes generated local to each hub — these create the density. */
  readonly spursPerHub: number;
  /** Long routes connecting hub pairs — these create the length. */
  readonly trunkRoutes: number;
  /**
   * Radius (Chebyshev tiles) around a hub that counts as "near" for both spur
   * generation and the concentration metric.
   */
  readonly hubRadiusTiles: number;
  /**
   * Extra step cost outside a hub's radius. Positive values make routes prefer
   * to stay inside the interesting neighbourhoods; the A* heuristic stays
   * admissible because the minimum step cost remains 1.
   */
  readonly awayFromHubCost: number;
  /** Extra cost for changing direction — high values make long straight runs. */
  readonly turnPenalty: number;
  /** Push route endpoints one tile into an adjacent wall (pipes do, track does not). */
  readonly entersWalls: boolean;
  /** Salt so two layers over the same map do not generate identical routes. */
  readonly seedSalt: string;
}

/** One maximal connected component of a finished occupancy grid. */
export interface LineworkRun {
  /** Number of tiles in this component (all branches counted). */
  readonly tileCount: number;
  /** How many of those tiles are within `hubRadiusTiles` of a hub. */
  readonly hubTileCount: number;
}

export interface LineworkPlan {
  readonly width: number;
  readonly height: number;
  /** `LINEWORK_*` per tile, row-major. */
  readonly occupancy: Uint8Array;
  /** 4-bit edge-Wang mask per occupied tile (0 elsewhere), row-major. */
  readonly masks: Uint8Array;
  /** Connected components, descending by tile count. */
  readonly runs: readonly LineworkRun[];
  /** Total occupied tiles. */
  readonly tileCount: number;
  /** Occupied tiles within `hubRadiusTiles` of a hub. */
  readonly hubTileCount: number;
}

export interface LineworkPlanRequest {
  readonly width: number;
  readonly height: number;
  /** Non-zero where a route may run (open floor + corridors). */
  readonly routable: Uint8Array;
  /** Non-zero where a wall stands — the only tiles `entersWalls` may claim. */
  readonly wall: Uint8Array;
  readonly hubs: readonly LineworkHub[];
  readonly floorSeed: number;
  readonly params: LineworkLayerParams;
}

// --- Priority queue -------------------------------------------------------

/**
 * Minimal binary min-heap over (priority, state) pairs.
 *
 * A sorted-array or repeated-scan frontier is O(n) per pop, which on a
 * 200×200 map with four incoming directions per tile (≈160 k states) turns a
 * floor-load-time route into a visible hitch.
 */
class MinHeap {
  private readonly priorities: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.values.length;
  }

  push(priority: number, value: number): void {
    this.priorities.push(priority);
    this.values.push(value);
    let i = this.values.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent]! <= this.priorities[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.values[0]!;
    const lastPriority = this.priorities.pop()!;
    const lastValue = this.values.pop()!;
    if (this.values.length > 0) {
      this.priorities[0] = lastPriority;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.values.length && this.priorities[left]! < this.priorities[smallest]!) {
          smallest = left;
        }
        if (right < this.values.length && this.priorities[right]! < this.priorities[smallest]!) {
          smallest = right;
        }
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const p = this.priorities[a]!;
    this.priorities[a] = this.priorities[b]!;
    this.priorities[b] = p;
    const v = this.values[a]!;
    this.values[a] = this.values[b]!;
    this.values[b] = v;
  }
}

// --- Routing --------------------------------------------------------------

/**
 * Number of distinct "incoming direction" states per tile: one per cardinal
 * plus a synthetic start state with no incoming direction (which is never
 * charged a turn penalty).
 */
const DIRECTION_STATES = 5;
const START_DIRECTION = 4;

/**
 * Turn-aware A* over the routable grid.
 *
 * State is (tile, incoming direction) rather than just tile, because the cost
 * of a step depends on whether it continues the previous heading. Without that,
 * a turn penalty cannot be expressed at all and routes come out as staircases:
 * every diagonal-ish path costs the same as a straight one, so the search
 * returns whichever the tie-break happens to hit, which reads as noise rather
 * than as a laid rail line.
 *
 * Returns the tile path (inclusive of both endpoints) or null if unreachable.
 */
function routeTurnAwareAStar(
  request: LineworkPlanRequest,
  nearHub: Uint8Array,
  startIndex: number,
  goalIndex: number,
): number[] | null {
  const { width, height, routable, params } = request;
  const cellCount = width * height;
  if (!routable[startIndex] || !routable[goalIndex]) return null;

  const stateCount = cellCount * DIRECTION_STATES;
  const gScore = new Float64Array(stateCount).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(stateCount).fill(-1);
  const closed = new Uint8Array(stateCount);

  const goalX = goalIndex % width;
  const goalY = (goalIndex / width) | 0;
  // Minimum step cost is 1, so Manhattan distance never overestimates.
  const heuristic = (index: number): number =>
    Math.abs((index % width) - goalX) + Math.abs(((index / width) | 0) - goalY);

  const open = new MinHeap();
  const startState = startIndex * DIRECTION_STATES + START_DIRECTION;
  gScore[startState] = 0;
  open.push(heuristic(startIndex), startState);

  let goalState = -1;
  while (open.size > 0) {
    const state = open.pop();
    if (closed[state]) continue;
    closed[state] = 1;
    const index = (state / DIRECTION_STATES) | 0;
    if (index === goalIndex) {
      goalState = state;
      break;
    }
    const incoming = state % DIRECTION_STATES;
    const tx = index % width;
    const ty = (index / width) | 0;
    const base = gScore[state]!;

    for (let d = 0; d < EDGE_WANG_DIRECTIONS.length; d++) {
      const { dx, dy } = EDGE_WANG_DIRECTIONS[d]!;
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIndex = ny * width + nx;
      if (!routable[nIndex]) continue;
      let cost = 1;
      if (incoming !== START_DIRECTION && incoming !== d) cost += params.turnPenalty;
      if (!nearHub[nIndex]) cost += params.awayFromHubCost;
      const nState = nIndex * DIRECTION_STATES + d;
      const tentative = base + cost;
      if (tentative >= gScore[nState]!) continue;
      gScore[nState] = tentative;
      cameFrom[nState] = state;
      open.push(tentative + heuristic(nIndex), nState);
    }
  }

  if (goalState < 0) return null;
  const path: number[] = [];
  for (let s = goalState; s >= 0; s = cameFrom[s]!) {
    path.push((s / DIRECTION_STATES) | 0);
  }
  path.reverse();
  return path;
}

/** Mark every tile within `radius` (Chebyshev) of any hub. */
function buildNearHubMask(
  width: number,
  height: number,
  hubs: readonly LineworkHub[],
  radius: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const hub of hubs) {
    const minY = Math.max(0, hub.ty - radius);
    const maxY = Math.min(height - 1, hub.ty + radius);
    const minX = Math.max(0, hub.tx - radius);
    const maxX = Math.min(width - 1, hub.tx + radius);
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) mask[ty * width + tx] = 1;
    }
  }
  return mask;
}

/**
 * Routable tiles within `radius` of a hub, in a deterministic order.
 *
 * Scanned row-major so the candidate list depends only on the map, never on
 * iteration order of a Set or on hub insertion order.
 */
function collectHubCandidates(
  request: LineworkPlanRequest,
  hub: LineworkHub,
  radius: number,
): number[] {
  const { width, height, routable } = request;
  const candidates: number[] = [];
  const minY = Math.max(0, hub.ty - radius);
  const maxY = Math.min(height - 1, hub.ty + radius);
  const minX = Math.max(0, hub.tx - radius);
  const maxX = Math.min(width - 1, hub.tx + radius);
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      const index = ty * width + tx;
      if (routable[index]) candidates.push(index);
    }
  }
  return candidates;
}

/**
 * Push a run's terminal tile one cell into an adjacent wall.
 *
 * A pipe that simply stops on open ground reads as a broken-off stub; a pipe
 * whose last cell is INSIDE the rock reads as plumbing that goes somewhere.
 * The wall-entry cell is stamped after the wall pass so the wall does not
 * overpaint it — see the linework pass in `terrain-renderer.ts`.
 *
 * The direction is chosen to CONTINUE the run's final heading where possible,
 * so the pipe drives into the wall it was already pointing at rather than
 * turning sideways at the last moment.
 */
function extendIntoWall(
  request: LineworkPlanRequest,
  occupancy: Uint8Array,
  path: readonly number[],
  atEnd: boolean,
): void {
  const { width, height, wall } = request;
  const terminal = atEnd ? path[path.length - 1]! : path[0]!;
  const previous = atEnd ? path[path.length - 2] : path[1];
  const tx = terminal % width;
  const ty = (terminal / width) | 0;

  let preferred = -1;
  if (previous !== undefined) {
    const heading = { dx: tx - (previous % width), dy: ty - ((previous / width) | 0) };
    preferred = EDGE_WANG_DIRECTIONS.findIndex((d) => d.dx === heading.dx && d.dy === heading.dy);
  }
  const order =
    preferred >= 0
      ? [preferred, ...EDGE_WANG_DIRECTIONS.map((_, i) => i).filter((i) => i !== preferred)]
      : EDGE_WANG_DIRECTIONS.map((_, i) => i);

  for (const d of order) {
    const { dx, dy } = EDGE_WANG_DIRECTIONS[d]!;
    const nx = tx + dx;
    const ny = ty + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const index = ny * width + nx;
    if (!wall[index] || occupancy[index]) continue;
    occupancy[index] = LINEWORK_WALL_ENTRY;
    return;
  }
}

/** Label 4-connected components of the occupancy grid and measure each. */
function measureRuns(
  width: number,
  height: number,
  occupancy: Uint8Array,
  nearHub: Uint8Array,
): LineworkRun[] {
  const seen = new Uint8Array(width * height);
  const runs: LineworkRun[] = [];
  const stack: number[] = [];
  for (let start = 0; start < occupancy.length; start++) {
    if (!occupancy[start] || seen[start]) continue;
    let tileCount = 0;
    let hubTileCount = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      tileCount++;
      if (nearHub[index]) hubTileCount++;
      const tx = index % width;
      const ty = (index / width) | 0;
      for (const { dx, dy } of EDGE_WANG_DIRECTIONS) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIndex = ny * width + nx;
        if (!occupancy[nIndex] || seen[nIndex]) continue;
        seen[nIndex] = 1;
        stack.push(nIndex);
      }
    }
    runs.push({ tileCount, hubTileCount });
  }
  runs.sort((a, b) => b.tileCount - a.tileCount);
  return runs;
}

/**
 * Plan one linework layer.
 *
 * Route order is fixed (all hub yards in hub order, then trunks in pair order)
 * and every random draw comes from one `SeededRandom` advanced in that fixed
 * order, so the result depends only on `(floorSeed, seedSalt, map)`.
 */
export function planLinework(request: LineworkPlanRequest): LineworkPlan {
  const { width, height, hubs, params, floorSeed } = request;
  const occupancy = new Uint8Array(width * height);
  const nearHub = buildNearHubMask(width, height, hubs, params.hubRadiusTiles);
  const rng = new SeededRandom((floorSeed ^ hashStringToSeed(params.seedSalt)) >>> 0);

  const paint = (path: readonly number[]): void => {
    for (const index of path) {
      if (occupancy[index] === LINEWORK_EMPTY) occupancy[index] = LINEWORK_GROUND;
    }
  };

  // Hub yards: short spurs local to one hub. These are what put density where
  // the human asked for it — around the boss dens and the central room.
  for (const hub of hubs) {
    const candidates = collectHubCandidates(request, hub, params.hubRadiusTiles);
    if (candidates.length < 2) continue;
    for (let spur = 0; spur < params.spursPerHub; spur++) {
      const a = candidates[rng.nextInt(0, candidates.length - 1)]!;
      const b = candidates[rng.nextInt(0, candidates.length - 1)]!;
      if (a === b) continue;
      const path = routeTurnAwareAStar(request, nearHub, a, b);
      if (!path) continue;
      paint(path);
      if (params.entersWalls) {
        extendIntoWall(request, occupancy, path, false);
        extendIntoWall(request, occupancy, path, true);
      }
    }
  }

  // Trunk lines: hub → hub, long enough to read as infrastructure crossing the
  // cavern. Deliberately NOT all-pairs — a fully connected trunk network merges
  // every yard into one giant component, which reads as a single sprawling mess
  // and collapses the run count.
  if (hubs.length >= 2) {
    for (let t = 0; t < params.trunkRoutes; t++) {
      const fromHub = hubs[t % hubs.length]!;
      const toHub = hubs[(t + 1) % hubs.length]!;
      const fromCandidates = collectHubCandidates(request, fromHub, params.hubRadiusTiles);
      const toCandidates = collectHubCandidates(request, toHub, params.hubRadiusTiles);
      if (fromCandidates.length === 0 || toCandidates.length === 0) continue;
      const a = fromCandidates[rng.nextInt(0, fromCandidates.length - 1)]!;
      const b = toCandidates[rng.nextInt(0, toCandidates.length - 1)]!;
      if (a === b) continue;
      const path = routeTurnAwareAStar(request, nearHub, a, b);
      if (!path) continue;
      paint(path);
    }
  }

  const masks = new Uint8Array(width * height);
  let tileCount = 0;
  let hubTileCount = 0;
  for (let index = 0; index < occupancy.length; index++) {
    if (!occupancy[index]) continue;
    tileCount++;
    if (nearHub[index]) hubTileCount++;
    masks[index] = edgeWangMaskFromOccupancy(
      occupancy,
      width,
      height,
      index % width,
      (index / width) | 0,
    );
  }

  return {
    width,
    height,
    occupancy,
    masks,
    runs: measureRuns(width, height, occupancy, nearHub),
    tileCount,
    hubTileCount,
  };
}

/**
 * Tiles a prop (switch lever, parked cart) may sit on.
 *
 * A prop must not contradict the linework under it, so it is only allowed where
 * the run has a definite direction to align with: a straight (exactly two
 * opposite connections) or a T-junction. Corners and crosses are excluded —
 * a cart parked on a curve or in the middle of a crossing reads as a mistake.
 */
export function isPropEligibleMask(mask: number): boolean {
  const straightNS = mask === (MASK_BIT.N | MASK_BIT.S);
  const straightEW = mask === (MASK_BIT.E | MASK_BIT.W);
  const isT =
    mask === (MASK_BIT.N | MASK_BIT.E | MASK_BIT.S) ||
    mask === (MASK_BIT.E | MASK_BIT.S | MASK_BIT.W) ||
    mask === (MASK_BIT.S | MASK_BIT.W | MASK_BIT.N) ||
    mask === (MASK_BIT.W | MASK_BIT.N | MASK_BIT.E);
  return straightNS || straightEW || isT;
}
